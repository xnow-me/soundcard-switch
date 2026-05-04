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

import GObject from "gi://GObject";
import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
      super._init(0.0);
      this.icon = new St.Icon();
      this.extensionObject = extensionObject;
      this.lastActiveModules = [];
      this.add_child(this.icon);
      this._destroyed = false;
      this._toggleSignalId = null;
      this._updateSourceId = null;

      this.menuItem = new PopupMenu.PopupSwitchMenuItem(
        "Sound Card",
        this._soundcard_status(),
      );
      this._toggleSignalId = this.menuItem.connect(
        "toggled",
        this._onToggle.bind(this),
      );

      this.menu.addMenuItem(this.menuItem);

      this.last_status = null;
      // init to correct status
      this._update_all();
    }

    destroy() {
      this._destroyed = true;
      if (this._toggleSignalId) {
        this.menuItem.disconnect(this._toggleSignalId);
        this._toggleSignalId = null;
      }
      if (this._updateSourceId) {
        GLib.Source.remove(this._updateSourceId);
        this._updateSourceId = null;
      }
      super.destroy();
    }

    _log(msg) {
      let version = this.extensionObject.metadata["version-name"] || "unknown";
      console.log(
        `[${this.extensionObject.uuid}_${version}]: ${msg}`,
      );
    }

    _logException(ex) {
      let version = this.extensionObject.metadata["version-name"] || "unknown";
      console.error(
        `[${this.extensionObject.uuid}_${version}]: ${ex.stack}, ${ex.message}`,
      );
    }

    _notify_result(message) {
      if (this._destroyed) {
        return;
      }
      Main.notify(this.extensionObject.metadata.name, message);
    }

    _notify_operation_result(desiredState, actualState) {
      if (actualState === desiredState) {
        this._notify_result(`Sound card turned ${desiredState ? "on" : "off"}`);
        return;
      }

      this._notify_result(
        `Failed to turn sound card ${desiredState ? "on" : "off"}`,
      );
    }

    _notify_operation_failed(desiredState, detail) {
      let action = desiredState ? "on" : "off";
      let message = `Failed to turn sound card ${action}`;
      if (detail) {
        message = `${message}: ${detail}`;
      }
      this._notify_result(message);
    }

    _soundcard_status() {
      return GLib.file_test("/sys/class/sound/card0/", GLib.FileTest.IS_DIR);
    }

    _get_command_path(commandName) {
      let paths = [
        `/usr/bin/${commandName}`,
        `/bin/${commandName}`,
        `/usr/sbin/${commandName}`,
        `/sbin/${commandName}`,
      ];

      for (let path of paths) {
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) {
          return path;
        }
      }

      return null;
    }

    /**
     * Run lspci asynchronously and pass the raw PCI device listing to callback.
     *
     * @param {Function} callback - Function called with raw lspci output.
     * @returns {void}
     */
    _run_lspci(callback) {
      let lspciPath = this._get_command_path("lspci");
      if (!lspciPath) {
        this._log("lspci executable not found in trusted system paths");
        callback("");
        return;
      }

      this._run_command_for_result(
        [lspciPath, "-D", "-k"],
        (success, stdout, stderr, status) => {
          if (!success) {
            this._log(this._format_command_failure(stdout, stderr, status));
            callback("");
            return;
          }

          callback(stdout);
        },
      );
    }

    /**
     * Parse lspci output into audio device module records.
     *
     * activeModule comes from sysfs, while candidateModules comes from the
     * lspci "Kernel modules" line. Only PCI devices whose lspci header line
     * contains "audio" are included.
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

    _format_command_failure(stdout, stderr, status) {
      let errorMessage = stderr ? stderr.trim() : "";
      let outputMessage = stdout ? stdout.trim() : "";

      return (
        errorMessage ||
        outputMessage ||
        `Command failed with status ${status}`
      );
    }

    _run_command_for_result(cmd, callback) {
      let subprocess;
      try {
        subprocess = Gio.Subprocess.new(
          cmd,
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
      } catch (e) {
        this._logException(e);
        callback(false, "", e.message, -1);
        return;
      }

      subprocess.communicate_utf8_async(null, null, (proc, res) => {
        if (this._destroyed) {
          return;
        }

        try {
          let [, stdout, stderr] = proc.communicate_utf8_finish(res);
          callback(
            proc.get_successful(),
            stdout || "",
            stderr || "",
            proc.get_exit_status(),
          );
        } catch (e) {
          this._logException(e);
          callback(false, "", e.message, -1);
        }
      });
    }

    _card_matches_pci_address(card, pciAddress) {
      let normalizedPciAddress = pciAddress.replace(/:/g, "_");
      let matchTokens = [
        pciAddress,
        normalizedPciAddress,
        `pci-${normalizedPciAddress}`,
      ];

      if (card.name && matchTokens.some(token => card.name.includes(token))) {
        return true;
      }

      let properties = card.properties || {};
      for (let key in properties) {
        let value = properties[key];
        if (typeof value !== "string") {
          continue;
        }

        if (matchTokens.some(token => value.includes(token))) {
          return true;
        }
      }

      return false;
    }

    _get_pactl_cards(pactlPath, callback) {
      this._run_command_for_result(
        [pactlPath, "--format=json", "list", "cards"],
        (success, stdout, stderr, status) => {
          if (!success) {
            this._log(this._format_command_failure(stdout, stderr, status));
            callback([]);
            return;
          }

          try {
            let cards = JSON.parse(stdout || "[]");
            if (!Array.isArray(cards)) {
              this._log("pactl returned an unexpected cards payload");
              callback([]);
              return;
            }

            callback(cards);
          } catch (e) {
            this._log(`Failed to parse pactl cards: ${e.message}`);
            callback([]);
          }
        },
      );
    }

    _get_matching_pactl_card_names(cards, moduleInfos) {
      let cardNames = [];
      let pciAddresses = this._unique_modules(
        moduleInfos
          .map(moduleInfo => moduleInfo.pciAddress)
          .filter(pciAddress => pciAddress),
      );

      for (let pciAddress of pciAddresses) {
        for (let card of cards) {
          if (!card.name || !this._card_matches_pci_address(card, pciAddress)) {
            continue;
          }

          cardNames.push(card.name);
        }
      }

      return this._unique_modules(cardNames);
    }

    _set_pactl_cards_off(pactlPath, cardNames, index, callback) {
      if (index >= cardNames.length) {
        callback(true, "");
        return;
      }

      this._run_command_for_result(
        [pactlPath, "set-card-profile", cardNames[index], "off"],
        (success, stdout, stderr, status) => {
          if (!success) {
            let detail = this._format_command_failure(stdout, stderr, status);
            this._log(detail);
            callback(false, detail);
            return;
          }

          this._set_pactl_cards_off(pactlPath, cardNames, index + 1, callback);
        },
      );
    }

    _turn_off_pactl_cards(moduleInfos, callback) {
      let pactlPath = this._get_command_path("pactl");
      if (!pactlPath) {
        this._log("pactl executable not found in trusted system paths");
        callback(true, "");
        return;
      }

      this._get_pactl_cards(pactlPath, cards => {
        let cardNames = this._get_matching_pactl_card_names(cards, moduleInfos);
        if (cardNames.length === 0) {
          this._log("No matching pactl cards found");
          callback(true, "");
          return;
        }

        this._set_pactl_cards_off(pactlPath, cardNames, 0, callback);
      });
    }

    /**
     * Get currently active audio modules from parsed audio device records.
     *
     * Non-empty output is cached in lastActiveModules so the extension can
     * later reload the same modules after they have been removed.
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

    _schedule_update(callback = null) {
      if (this._destroyed) {
        return;
      }

      if (this._updateSourceId) {
        GLib.Source.remove(this._updateSourceId);
      }
      // delay 1s, then update icon and toggle state
      // make sure the kernel module state has settled
      this._updateSourceId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        1,
        () => {
          if (this._destroyed) {
            this._updateSourceId = null;
            return GLib.SOURCE_REMOVE;
          }

          let status = this._update_all();
          this._updateSourceId = null;
          if (callback) {
            callback(status);
          }
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    /**
     * Run a command asynchronously, log failures, and refresh the UI afterward.
     *
     * @param {Array<string>} cmd - Command and arguments to execute.
     * @param {boolean} desiredState - Expected sound card state after success.
     * @returns {void}
     */
    _run_command(cmd, desiredState) {
      this._run_command_for_result(cmd, (success, stdout, stderr, status) => {
        if (!success) {
          let detail = this._format_command_failure(stdout, stderr, status);
          this._log(detail);
          this._notify_operation_failed(desiredState, detail);
          this._schedule_update();
          return;
        }

        this._schedule_update(actualState => {
          this._notify_operation_result(desiredState, actualState);
        });
      });
    }

    /**
     * Build and run the privileged modprobe command for audio modules.
     *
     * @param {Array<string>} modules - Kernel modules to load or remove.
     * @param {Array<string>} args - modprobe operation arguments.
     * @param {boolean} desiredState - Expected sound card state after success.
     * @returns {void}
     */
    _run_modprobe(modules, args, desiredState) {
      if (modules.length === 0) {
        this._log("No sound card kernel modules found");
        this._notify_result("No sound card kernel modules found");
        this._schedule_update();
        return;
      }

      let modprobePath = this._get_command_path("modprobe");
      if (!modprobePath) {
        this._log("modprobe executable not found in trusted system paths");
        this._notify_result("modprobe executable not found");
        this._schedule_update();
        return;
      }

      let cmd = ["pkexec", modprobePath];
      // pkexec fits GNOME's graphical auth flow; modprobe resolves module
      // paths and dependencies better than calling insmod/rmmod directly.
      cmd.push(...args);
      cmd.push(...modules);
      this._run_command(cmd, desiredState);
    }

    _load_modules(modules) {
      let args = modules.length > 1 ? ["-a"] : [];
      this._run_modprobe(modules, args, true);
    }

    _remove_modules(modules) {
      this._run_modprobe(modules, ["-r"], false);
    }

    _run_remove_flow(modules, moduleInfos) {
      if (modules.length === 0) {
        this._remove_modules(modules);
        return;
      }

      this._turn_off_pactl_cards(moduleInfos, (success, detail) => {
        if (this._destroyed) {
          return;
        }

        if (!success) {
          this._notify_operation_failed(false, detail);
          this._schedule_update();
          return;
        }

        this._remove_modules(modules);
      });
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
      return status;
    }

    /**
     * Handle the user toggling the sound card switch.
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
        if (state) {
          this._load_modules(modules);
          return;
        }

        this._run_remove_flow(modules, moduleInfos);
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
    if (!this._indicator) {
      return;
    }

    this._indicator.destroy();
    this._indicator = null;
  }
}
