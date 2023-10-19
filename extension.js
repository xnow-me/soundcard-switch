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

const GETTEXT_DOMAIN = 'my-indicator-extension';

const {GObject, St, Gio, GLib} = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const App = ExtensionUtils.getCurrentExtension();

let sourceId = null;
const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        this.icon = new St.Icon();
        this.add_child(this.icon);

        this.menuItem = new PopupMenu.PopupSwitchMenuItem(
            'Sound Card', this._soundcard_status());
        this.menuItem.connect('toggled', this._onToggle.bind(this));

        this.menu.addMenuItem(this.menuItem);

        this.last_status = null;
        // init to correct status
        this._update_all();
    }

    _log(msg) {
        console.log(`[${App.uuid}_${App.metadata.version}]: ${msg}`);
    }

    _logException(ex) {
        console.error(`[${App.uuid}_${App.metadata.version}]: ${ex.stack}, ${ex.message}`);
    }


    _soundcard_status() {
        let cmd = 'ls -d /sys/class/sound/card0/';
        try {
            let [result, stdout, stderr, status] = GLib.spawn_command_line_sync(cmd);
            return status === 0;
        } catch (e) {
            this._logException(e);
            return false;
        }
    }

    _write_command(cmd) {
        let proc = Gio.Subprocess.new(cmd, Gio.SubprocessFlags.STDIN_PIPE);
        proc.communicate_utf8_async('1', null, (proc, res) => {
            try {
                let [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
                // delay 1s, than update icon and toggle state
                // make sure the /sys/class/sound/card0/ dir show or disappear
                sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    this._update_all();
                    return GLib.SOURCE_REMOVE;
                });
            } catch (e) {
                this._logException(e);
            }
        });
    }

    _update_icon(status) {
        let iconStatus = status ? 'enable' : 'disable';
        let baseIcon = `${App.path}/icons/${iconStatus}`;
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
            let msg = `Turned SoundCard ${status ? 'On' : 'Off'}`;
            Main.notify(msg);
            this._log(msg);
        }
        this.last_status = status;
    }

    _onToggle(menuItem, state) {
        if (state) {
            let cmd = ['pkexec', 'tee', '/sys/bus/pci/rescan'];
            this._write_command(cmd);
        } else {
            let cmd = ['pkexec', 'tee', '/sys/class/sound/card0/device/remove'];
            this._write_command(cmd);
        }
    }
});

class Extension {
    constructor(uuid) {
        this._uuid = uuid;

        ExtensionUtils.initTranslations(GETTEXT_DOMAIN);
    }

    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this._uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
        if (sourceId) {
            GLib.Source.remove(sourceId);
            sourceId = null;
        }
    }
}

/**
 *
 * @param meta
 */
function init(meta) {
    return new Extension(meta.uuid);
}
