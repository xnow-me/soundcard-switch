UUID := $(shell sed -n 's/^[[:space:]]*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' metadata.json)

ifeq ($(strip $(UUID)),)
$(error Could not read uuid from metadata.json)
endif

BUILD_DIR := build/$(UUID)
DIST_DIR := dist
ZIP_FILE := $(DIST_DIR)/$(UUID).shell-extension.zip
INSTALL_DIR ?= $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

EXTENSION_FILES := extension.js metadata.json LICENSE
EXTENSION_DIRS := icons

.PHONY: all package install uninstall clean

all: package

package: $(ZIP_FILE)

$(ZIP_FILE): Makefile $(EXTENSION_FILES) $(shell find $(EXTENSION_DIRS) -type f)
	@rm -rf "$(BUILD_DIR)"
	@mkdir -p "$(BUILD_DIR)" "$(DIST_DIR)"
	@cp $(EXTENSION_FILES) "$(BUILD_DIR)/"
	@cp -R $(EXTENSION_DIRS) "$(BUILD_DIR)/"
	@rm -f "$(ZIP_FILE)"
	@cd "$(BUILD_DIR)" && zip -qr "../../$(ZIP_FILE)" .
	@printf 'Packaged %s -> %s\n' "$(UUID)" "$(ZIP_FILE)"

install: package
	@rm -rf "$(INSTALL_DIR)"
	@mkdir -p "$(INSTALL_DIR)"
	@unzip -q "$(ZIP_FILE)" -d "$(INSTALL_DIR)"
	@printf 'Installed %s -> %s\n' "$(UUID)" "$(INSTALL_DIR)"

uninstall:
	@rm -rf "$(INSTALL_DIR)"
	@printf 'Uninstalled %s from %s\n' "$(UUID)" "$(INSTALL_DIR)"

clean:
	@rm -rf build "$(DIST_DIR)"
