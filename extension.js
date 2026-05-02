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

let updateSourceId = null;
const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
      super._init(0.0);
      this.icon = new St.Icon();
      this.extensionObject = extensionObject;
      this.lastActiveModules = [];
      this.add_child(this.icon);
      this._destroyed = false;

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
      this._destroyed = true;
      if (updateSourceId) {
        GLib.Source.remove(updateSourceId);
        updateSourceId = null;
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

    _soundcard_status() {
      return GLib.file_test("/sys/class/sound/card0/", GLib.FileTest.IS_DIR);
    }

    _find_executable(commandName, fallbackPaths) {
      let programPath = GLib.find_program_in_path(commandName);
      if (programPath) {
        return programPath;
      }

      for (let fallbackPath of fallbackPaths) {
        if (GLib.file_test(fallbackPath, GLib.FileTest.IS_EXECUTABLE)) {
          return fallbackPath;
        }
      }

      return commandName;
    }

    _get_lspci_path() {
      return this._find_executable("lspci", [
        "/usr/bin/lspci",
        "/bin/lspci",
      ]);
    }

    _get_modprobe_path() {
      return this._find_executable("modprobe", [
        "/usr/sbin/modprobe",
        "/sbin/modprobe",
        "/usr/bin/modprobe",
        "/bin/modprobe",
      ]);
    }

    /**
     * Run lspci asynchronously and pass the raw PCI device listing to callback.
     *
     * Example output:
     * 0000:00:1f.3 Audio device: Intel Corporation Device 7a50
     *     Kernel modules: snd_hda_intel
     *
     * @param {Function} callback - Function called with raw lspci output.
     * @returns {void}
     */
    _run_lspci(callback) {
      let subprocess;
      try {
        subprocess = Gio.Subprocess.new(
          [this._get_lspci_path(), "-D", "-k"],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
      } catch (e) {
        this._logException(e);
        callback("");
        return;
      }

      subprocess.communicate_utf8_async(null, null, (proc, res) => {
        try {
          let [, stdout, stderr] = proc.communicate_utf8_finish(res);
          if (!proc.get_successful()) {
            let errorMessage = stderr ? stderr.trim() : "";
            this._log(errorMessage || "Failed to list PCI devices");
            callback("");
            return;
          }
          callback(stdout || "");
        } catch (e) {
          this._logException(e);
          callback("");
        }
      });
    }

    /**
     * Parse lspci output into audio device module records.
     *
     * activeModule comes from sysfs, while candidateModules comes from the
     * lspci "Kernel modules" line. Only PCI devices whose lspci header line
     * contains "audio" are included.
     *
     * Example output:
     * [
     *   {
     *     activeModule: "snd_hda_intel",
     *     candidateModules: ["snd_hda_intel"],
     *     deviceName: "Audio device: Intel Corporation Device 7a50",
     *     pciAddress: "0000:00:1f.3",
     *   },
     * ]
     *
     * @param {string} lspciOutput - Raw lspci output.
     * @returns {Array<Object>} Audio device records with active and candidate modules.
     */
    _parse_audio_module_infos(lspciOutput) {
      let moduleInfos = [];
      let currentInfo = null;

      for (let line of lspciOutput.split("\n")) {
        // lspci -D prints the full PCI address used by /sys/bus/pci/devices.
        let deviceMatch = line.match(
          /^([0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-7])\s+/,
        );
        if (deviceMatch) {
          if (currentInfo) {
            moduleInfos.push(currentInfo);
          }

          let pciAddress = deviceMatch[1];
          currentInfo = /\baudio\b/i.test(line)
            ? {
                activeModule: this._get_active_module_from_sysfs(pciAddress),
                candidateModules: [],
                deviceName: line.slice(pciAddress.length).trim(),
                pciAddress,
              }
            : null;
          continue;
        }

        if (!currentInfo) {
          continue;
        }

        let modulesMatch = line.match(/^\s*Kernel modules:\s*(.+)$/);
        if (modulesMatch) {
          currentInfo.candidateModules = modulesMatch[1]
            .split(",")
            .map(moduleName => moduleName.trim())
            .filter(moduleName => moduleName);
        }
      }

      if (currentInfo) {
        moduleInfos.push(currentInfo);
      }

      return moduleInfos;
    }

    /**
     * Get audio device module records asynchronously.
     *
     * Example output:
     * [{activeModule: "snd_hda_intel", candidateModules: ["snd_hda_intel"]}]
     *
     * @param {Function} callback - Function called with audio module records.
     * @returns {void}
     */
    _get_audio_module_infos(callback) {
      this._run_lspci(lspciOutput => {
        callback(this._parse_audio_module_infos(lspciOutput));
      });
    }

    _get_module_name(modulePath) {
      let parts = modulePath.split("/");
      return parts[parts.length - 1] || null;
    }

    /**
     * Read the active kernel module for one PCI device from sysfs.
     *
     * Example input: 0000:00:1f.3
     * Example output: snd_hda_intel
     *
     * @param {string} pciAddress - Full PCI address from lspci -D output.
     * @returns {string|null} Active module name, or null if no module link exists.
     */
    _get_active_module_from_sysfs(pciAddress) {
      try {
        // The sysfs driver/module link points to the real kernel module.
        let modulePath = GLib.file_read_link(
          `/sys/bus/pci/devices/${pciAddress}/driver/module`,
        );
        return this._get_module_name(modulePath);
      } catch (e_) {
        return null;
      }
    }

    _unique_modules(modules) {
      let seen = new Set();
      return modules.filter(moduleName => {
        if (seen.has(moduleName)) {
          return false;
        }
        seen.add(moduleName);
        return true;
      });
    }

    /**
     * Get currently active audio modules from parsed audio device records.
     *
     * Non-empty output is cached in lastActiveModules so the extension can
     * later reload the same modules after they have been removed.
     *
     * Example input: [{activeModule: "snd_hda_intel"}, {activeModule: null}]
     * Example output: ["snd_hda_intel"]
     *
     * @param {Array<Object>} moduleInfos - Audio device records.
     * @returns {Array<string>} Unique active module names.
     */
    _get_active_modules(moduleInfos) {
      let activeModules = this._unique_modules(
        moduleInfos
          .map(moduleInfo => moduleInfo.activeModule)
          .filter(moduleName => moduleName),
      );
      if (activeModules.length > 0) {
        this.lastActiveModules = activeModules;
      }
      return activeModules;
    }

    /**
     * Choose modules to load when turning the sound card back on.
     *
     * If modules were previously active, they are reused. Otherwise this
     * falls back to all modules listed in each device's candidateModules.
     *
     * Example input:
     * [{candidateModules: ["snd_hda_intel", "snd_soc_avs"]}]
     * Example output when no cache exists: ["snd_hda_intel", "snd_soc_avs"]
     *
     * @param {Array<Object>} moduleInfos - Audio device records.
     * @returns {Array<string>} Unique module names to pass to modprobe.
     */
    _get_loadable_modules(moduleInfos) {
      if (this.lastActiveModules.length > 0) {
        return this.lastActiveModules;
      }

      return this._unique_modules(
        moduleInfos
          .flatMap(moduleInfo => moduleInfo.candidateModules)
          .filter(moduleName => moduleName),
      );
    }

    _schedule_update() {
      if (this._destroyed) {
        return;
      }

      if (updateSourceId) {
        GLib.Source.remove(updateSourceId);
      }
      // delay 1s, then update icon and toggle state
      // make sure the kernel module state has settled
      updateSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        this._update_all();
        updateSourceId = null;
        return GLib.SOURCE_REMOVE;
      });
    }

    /**
     * Run a command asynchronously, log failures, and refresh the UI afterward.
     *
     * Example input: ["pkexec", "modprobe", "-r", "snd_hda_intel"]
     * Example output: no direct return value; failed stderr/stdout is logged.
     *
     * @param {Array<string>} cmd - Command and arguments to execute.
     * @returns {void}
     */
    _run_command(cmd) {
      let subprocess;
      try {
        subprocess = Gio.Subprocess.new(
          cmd,
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
      } catch (e) {
        this._logException(e);
        this._schedule_update();
        return;
      }

      subprocess.communicate_utf8_async(null, null, (proc, res) => {
        try {
          let [, stdout, stderr] = proc.communicate_utf8_finish(res);
          if (!proc.get_successful()) {
            let errorMessage = stderr ? stderr.trim() : "";
            let outputMessage = stdout ? stdout.trim() : "";
            this._log(
              errorMessage ||
                outputMessage ||
                `Command failed with status ${proc.get_exit_status()}`,
            );
          }
          this._schedule_update();
        } catch (e) {
          this._logException(e);
          this._schedule_update();
        }
      });
    }

    /**
     * Build and run the privileged modprobe command for audio modules.
     *
     * Example input: modules ["snd_hda_intel"], remove true
     * Example command: ["pkexec", "/usr/sbin/modprobe", "-r", "snd_hda_intel"]
     *
     * Example input: modules ["snd_hda_intel", "snd_soc_avs"], remove false
     * Example command: ["pkexec", "/usr/sbin/modprobe", "-a", "snd_hda_intel", "snd_soc_avs"]
     *
     * @param {Array<string>} modules - Kernel modules to load or remove.
     * @param {boolean} remove - Whether to remove modules instead of loading them.
     * @returns {void}
     */
    _run_modprobe(modules, remove) {
      if (modules.length === 0) {
        this._log("No sound card kernel modules found");
        this._schedule_update();
        return;
      }

      let cmd = ["pkexec", this._get_modprobe_path()];
      // pkexec fits GNOME's graphical auth flow; modprobe resolves module
      // paths and dependencies better than calling insmod/rmmod directly.
      if (remove) {
        cmd.push("-r");
      } else if (modules.length > 1) {
        cmd.push("-a");
      }
      cmd.push(...modules);
      this._run_command(cmd);
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

    /**
     * Handle the user toggling the sound card switch.
     *
     * Example input: state false
     * Example output: runs pkexec modprobe -r with active audio modules.
     *
     * Example input: state true
     * Example output: runs pkexec modprobe with cached or candidate modules.
     *
     * @param {PopupMenu.PopupSwitchMenuItem} _menuItem - Switch menu item.
     * @param {boolean} state - Desired enabled state after the toggle.
     * @returns {void}
     */
    _onToggle(_menuItem, state) {
      this._get_audio_module_infos(moduleInfos => {
        if (this._destroyed) {
          return;
        }

        let modules = state
          ? this._get_loadable_modules(moduleInfos)
          : this._get_active_modules(moduleInfos);
        this._run_modprobe(modules, !state);
      });
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
