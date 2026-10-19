# SPDX-License-Identifier: GPL-3.0-or-later
DEMO_SCRIPTS := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
include $(DEMO_SCRIPTS)runtime.mk

DEMO_COMMA := ,
LDFLAGS := $(subst _emscripten_pause_main_loop],_emscripten_pause_main_loop$(DEMO_COMMA)_neverhood_demo_state],$(LDFLAGS))
DEMO_OVERLAYS := $(CURDIR)/overlays
DEMO_OBJECTS := engines/neverhood/gamemodule.o engines/neverhood/modules/module1000.o engines/neverhood/saveload.o engines/engine.o backends/fs/emscripten/emscripten-fs-factory.o

$(DEMO_OBJECTS): %.o: $(DEMO_OVERLAYS)/%.cpp
	$(QUIET)$(MKDIR) $(*D)/$(DEPDIR)
	$(QUIET_CXX)$(CXX) $(CXX_UPDATE_DEP_FLAG) $(CXXFLAGS) $(CPPFLAGS) -c $< -o $@

$(EXECUTABLE): .EXTRA_PREREQS := $(DEMO_SCRIPTS)demo-runtime.mk $(DEMO_SCRIPTS)runtime.mk
