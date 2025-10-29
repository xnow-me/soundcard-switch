/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* exported init */

import GObject from "gi://GObject";
import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

let sourceId = null;
const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
      super._init(0.0);
      this.icon = new St.Icon();
      this.extensionObject = extensionObject;
      this.add_child(this.icon);

      this.menuItem = new PopupMenu.PopupSwitchMenuItem(
        "Sound Card",
        this._soundcard_status(),
      );
      this.menuItem.connect("toggled", this._onToggle.bind(this));

      this.menu.addMenuItem(this.menuItem);

      this.last_status = null;
      // init to correct status
      this._update_all();
    }
    destroy() {
      if (sourceId) {
        GLib.Source.remove(sourceId);
        sourceId = null;
      }
      super.destroy();
    }

    _log(msg) {
      console.log(
        `[${this.extensionObject.uuid}_${this.extensionObject.metadata.version}]: ${msg}`,
      );
    }

    _logException(ex) {
      console.error(
        `[${this.extensionObject.uuid}_${this.extensionObject.metadata.version}]: ${ex.stack}, ${ex.message}`,
      );
    }

    // get audio device kernel modules from lspci -k output
    _get_audio_modules() {
      let cmd = "lspci -k";

      let [_ok, stdout, stderr, status] = GLib.spawn_command_line_sync(cmd);
      if (status !== 0) {
        this._logException(`Error getting module list: ${stderr}`);
        return "";
      }

      let stdout_parts = new TextDecoder().decode(stdout).split("\n");
      let find_audio_line = null;
      let audio_module_line = null;
      for (let i = 0; i < stdout_parts.length; i++) {
        if (stdout_parts[i].toLowerCase().includes("audio device:")) {
          find_audio_line = true;
          continue;
        }
        if (
          find_audio_line &&
          stdout_parts[i].toLowerCase().includes("kernel modules:")
        ) {
          audio_module_line = stdout_parts[i];
          break;
        }
      }

      let modules = audio_module_line
        .split(":")[1]
        .split(",")
        .map((s) => s.trim());
      return modules;
    }

    _exec_async(cmd, callback = null, errorCallback = null) {
      let proc = Gio.Subprocess.new(
        cmd, // like ["ls", "-a"]
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      );

      proc.communicate_utf8_async(null, null, (source, result) => {
        try {
          let [ok, stdout, stderr] = source.communicate_utf8_finish(result);
          if (ok) {
            this._log(`Executed ${cmd} successfully!`);
            if (callback) callback();
          } else {
            this._log(`Command ${cmd} failed with status: ` + ok);
            this._logException("Error Output: " + stderr);
            if (errorCallback) errorCallback(stderr);
          }
          return [ok, stdout, stderr];
        } catch (e) {
          this._logException(`Error executing ${cmd} command: ` + e.message);
          if (errorCallback) errorCallback(e.message);
        }
      });
    }

    // update all status after sec seconds
    _update_all_after_second(sec) {
      this.sourceId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        sec,
        () => {
          this._update_all();
          this.sourceId = null;
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    // unload audio device kernel modules by modprobe -r
    _unload_audio_module() {
      let audio_module = this._get_audio_modules();
      let cmd = ["pkexec", "/sbin/modprobe", "-ar"].concat(audio_module);
      this._log(`Unloading module: ${audio_module}, with cmd: ${cmd}`);

      this._exec_async(cmd, () => {
        this._update_all_after_second(1);
      });
    }

    // load audio device kernel modules by modprobe -a
    _load_audio_module() {
      let audio_module = this._get_audio_modules();
      let cmd = ["pkexec", "/sbin/modprobe", "-a"].concat(audio_module);
      this._log(`Loading module: ${audio_module}, with cmd: ${cmd}`);

      this._exec_async(cmd, () => {
        this._update_all_after_second(1);
      });
    }

    _soundcard_status() {
      let cmd = "ls -d /sys/class/sound/card0/";
      try {
        let [_ok, _stdout, _stderr, status] = GLib.spawn_command_line_sync(cmd);
        return status === 0;
      } catch (e) {
        this._logException(e);
        return false;
      }
    }

    _update_icon(status) {
      let iconStatus = status ? "enable" : "disable";
      let baseIcon = `${this.extensionObject.path}/icons/${iconStatus}`;
      let fileIcon = Gio.File.new_for_path(`${baseIcon}.svg`);
      let icon = Gio.icon_new_for_string(fileIcon.get_path());
      this.icon.set_gicon(icon);
      this.icon.set_icon_size(26);
    }

    _update_toggle(status) {
      this.menuItem.setToggleState(status);
    }

    // update icon and toggle status
    _update_all() {
      let status = this._soundcard_status();
      this._update_icon(status);
      this._update_toggle(status);
      if (this.last_status !== null && this.last_status !== status) {
        let msg = `Turned SoundCard ${status ? "On" : "Off"}`;
        this._log(msg);
      }
      this.last_status = status;
    }

    _onToggle(menuItem, state) {
      if (state) {
        this._load_audio_module();
      } else {
        this._unload_audio_module();
      }
    }
  },
);

export default class SoundcardExtension extends Extension {
  enable() {
    this._indicator = new Indicator(this);
    Main.panel.addToStatusArea(this._uuid, this._indicator);
  }

  disable() {
    this._indicator.destroy();
    this._indicator = null;
  }
}
