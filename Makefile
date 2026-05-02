UUID := $(shell sed -n 's/^[[:space:]]*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' metadata.json)
VERSION := $(shell sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' metadata.json)

ifeq ($(strip $(UUID)),)
$(error Could not read uuid from metadata.json)
endif

ifeq ($(strip $(VERSION)),)
$(error Could not read version from metadata.json)
endif

BUILD_DIR := build/$(UUID)
DIST_DIR := dist
ZIP_FILE := $(DIST_DIR)/$(UUID).shell-extension.zip
INSTALL_DIR ?= $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

EXTENSION_FILES := extension.js metadata.json LICENSE README.md
EXTENSION_DIRS := icons

.PHONY: all package install uninstall clean

all: package

package: $(ZIP_FILE)

$(ZIP_FILE): $(EXTENSION_FILES) $(shell find $(EXTENSION_DIRS) -type f)
	@rm -rf "$(BUILD_DIR)"
	@mkdir -p "$(BUILD_DIR)" "$(DIST_DIR)"
	@cp $(EXTENSION_FILES) "$(BUILD_DIR)/"
	@cp -R $(EXTENSION_DIRS) "$(BUILD_DIR)/"
	@cd "$(BUILD_DIR)" && zip -qr "../../$(ZIP_FILE)" .
	@printf 'Packaged %s version %s -> %s\n' "$(UUID)" "$(VERSION)" "$(ZIP_FILE)"

install: package
	@rm -rf "$(INSTALL_DIR)"
	@mkdir -p "$(INSTALL_DIR)"
	@cp -R "$(BUILD_DIR)/." "$(INSTALL_DIR)/"
	@printf 'Installed %s -> %s\n' "$(UUID)" "$(INSTALL_DIR)"

uninstall:
	@rm -rf "$(INSTALL_DIR)"
	@printf 'Uninstalled %s from %s\n' "$(UUID)" "$(INSTALL_DIR)"

clean:
	@rm -rf build "$(DIST_DIR)"
