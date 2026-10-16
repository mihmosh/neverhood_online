# SPDX-License-Identifier: GPL-3.0-or-later
include Makefile

# Upstream's JS library path assumes an in-tree build.
LDFLAGS := $(subst --js-library backends/,--js-library $(srcdir)/backends/,$(LDFLAGS))
# The external launcher supplies arguments; Neverhood does not need Web MIDI.
LDFLAGS := $(subst --pre-js $(srcdir)/dists/emscripten/custom_shell-pre.js,,$(LDFLAGS))
# Keep upstream's exports and expose the filesystem to the external launcher.
LDFLAGS += -s EXPORTED_RUNTIME_METHODS=[ccall,lengthBytesUTF8,setValue,writeArrayToMemory,FS,IDBFS,callMain,getValue]
# Observe the existing engine pointer without changing upstream source.
LDFLAGS += -s EXPORTED_FUNCTIONS=[_main,_malloc,_free,_raise,_g_engine,_SDL_GetWindowFromID,_SDL_SetWindowSize,_emscripten_pause_main_loop]
LDFLAGS += -s EXIT_RUNTIME=1

$(EXECUTABLE): .EXTRA_PREREQS := $(firstword $(MAKEFILE_LIST))
