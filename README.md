Welcome to SoundCard Switch
---

## Description

SoundCard Switch is a Gnome Shell indicator extension designed to enable users to fully disable or enable their laptop's sound card by loading or unloading the sound card kernel module.

This is particularly useful in office environments or other public places where unexpected sounds from your computer may be disruptive.


## Prerequisites

SoundCard Switch functions by running modprobe to load or unload the sound card kernel module. Therefore, pkexec is required to execute these privileged actions.

The extension detects PCI audio device modules with lspci and keeps a single switch for controlling all detected sound card modules.

## Installation


To install SoundCard Switch, visit the [Gnome Extensions](https://extensions.gnome.org/) page, search for SoundCardSwitch, and enable it with a simple click.

## Screenshot

![SoundCard Switch](./screenshot/screenshot.png)
