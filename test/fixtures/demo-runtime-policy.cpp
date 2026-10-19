// SPDX-License-Identifier: GPL-3.0-or-later
// Compile the actual generated function bodies against resource-counting stubs.
#include <cassert>
#include <cstdio>
#include <stdexcept>

#define debug(...) ((void)0)
#define SetUpdateHandler(...) ((void)0)
#define NM_KEYPRESS_ESC 0
typedef unsigned int uint32;
enum { V_MODULE_NAME, V_TELEPORTER_CURR_LOCATION };
static volatile int neverhood_demo_state = 0;
static int forbiddenResources = 0;
static int allowedResources = 0;
static void setGlobalVar(int, unsigned int) {}
static void error(const char *, int) { throw std::runtime_error("unexpected module"); }
struct Sound {
 void startMusic(unsigned int, int, int) { ++allowedResources; }
 void stopMusic(unsigned int, int, int) { ++forbiddenResources; }
};
struct State { int sceneNum = -1; int which = -1; };
struct VM {
 bool quit = false;
 bool _isSaveAllowed = true;
 State state;
 Sound sound;
 Sound *_soundMan = &sound;
 State &gameState() { return state; }
 bool isDemo() const { return false; }
 void quitGame() { quit = true; }
};
struct Child {
 virtual ~Child() {}
 virtual void handleUpdate() {}
};
struct Scene1001 : Child { Scene1001(VM *, void *, int) { ++allowedResources; } };
struct Scene1002 : Child { Scene1002(VM *, void *, int) { ++allowedResources; } };
struct Scene1004 : Child { Scene1004(VM *, void *, int) { ++forbiddenResources; } };
struct Scene1005 : Child { Scene1005(VM *, void *, int) { ++forbiddenResources; } };
struct Module1000 : Child {
 VM *_vm;
 Child *_childObject = nullptr;
 int _sceneNum = -1;
 int _moduleResult = 0;
 bool finished = false;
 bool left = false;
 unsigned int _musicFileHash = 0;
 Module1000(VM *vm, void *, int which) : _vm(vm) { createScene(0, which); }
 ~Module1000() { delete _childObject; }
 void createScene(int sceneNum, int which);
 void updateScene();
 void createStaticScene(unsigned int, unsigned int) { _childObject = new Child; ++allowedResources; }
 void leaveModule(int) { left = true; }
 bool updateChild() {
  if (!finished) return true;
  finished = false;
  delete _childObject;
  _childObject = nullptr;
  return false;
 }
};
#define FORBIDDEN_MODULE(N) struct Module##N : Child { Module##N(VM *, void *, int) { ++forbiddenResources; } };
FORBIDDEN_MODULE(1100) FORBIDDEN_MODULE(1200) FORBIDDEN_MODULE(1300)
FORBIDDEN_MODULE(1400) FORBIDDEN_MODULE(1500) FORBIDDEN_MODULE(1600)
FORBIDDEN_MODULE(1700) FORBIDDEN_MODULE(1800) FORBIDDEN_MODULE(1900)
FORBIDDEN_MODULE(2000) FORBIDDEN_MODULE(2100) FORBIDDEN_MODULE(2200)
FORBIDDEN_MODULE(2300) FORBIDDEN_MODULE(2400) FORBIDDEN_MODULE(2500)
FORBIDDEN_MODULE(2600) FORBIDDEN_MODULE(2700) FORBIDDEN_MODULE(2800)
FORBIDDEN_MODULE(2900) FORBIDDEN_MODULE(3000)
struct GameModule {
 VM *_vm;
 Child *_childObject = nullptr;
 Child *_prevChildObject = nullptr;
 int _moduleNum = -1;
 bool _canRequestMainMenu = true;
 bool _mainMenuRequested = false;
 explicit GameModule(VM *vm) : _vm(vm) {}
 ~GameModule() { delete _childObject; }
 void startup();
 void createModule(int moduleNum, int which);
 void handleEscapeKey();
 void updateModule() {}
 void sendMessage(Child *, int, int) { ++forbiddenResources; }
 void createDemoScene() { ++forbiddenResources; }
};

// DEMO_OVERLAY_FUNCTIONS

static void transition(Module1000 *module, int result) {
 module->_moduleResult = result;
 module->finished = true;
 module->updateScene();
}
int main() {
 assert(neverhood_demo_state == 0);
 {
  VM vm;
  GameModule game(&vm);
  game.startup();
  assert(neverhood_demo_state == 1 && !vm.quit && !vm._isSaveAllowed);
  assert(game._moduleNum == 1000 && vm.state.sceneNum == 0 && vm.state.which == 0);
  Module1000 *module = static_cast<Module1000 *>(game._childObject);
  assert(module->_sceneNum == 0);
  transition(module, 2);
  assert(module->_sceneNum == 2 && neverhood_demo_state == 1);
  transition(module, 0);
  assert(module->_sceneNum == 0);
  transition(module, 0);
  assert(module->_sceneNum == 1);
  transition(module, 0);
  assert(module->_sceneNum == 0);
  transition(module, 0);
  const int resources = allowedResources;
  transition(module, 2);
  assert(vm.quit && neverhood_demo_state == 2);
  assert(allowedResources == resources && forbiddenResources == 0);
  game.handleEscapeKey();
  assert(neverhood_demo_state == 2);
 }
 {
  VM vm;
  GameModule game(&vm);
  game.startup();
  Module1000 *module = static_cast<Module1000 *>(game._childObject);
  transition(module, 0);
  transition(module, 1);
  assert(module->left);
  const int resources = allowedResources;
  game.createModule(2300, 0);
  assert(vm.quit && neverhood_demo_state == 2 && allowedResources == resources);
 }
 for (int scene : {-1, 3, 4, 99}) {
  VM vm;
  GameModule game(&vm);
  game.startup();
  static_cast<Module1000 *>(game._childObject)->createScene(scene, 0);
  assert(vm.quit && neverhood_demo_state == 2 && forbiddenResources == 0);
 }
 for (int id : {1100, 1500, 2300, 9999, -1}) {
  VM vm;
  GameModule game(&vm);
  game.startup();
  game.createModule(id, 0);
  assert(vm.quit && neverhood_demo_state == 2 && forbiddenResources == 0);
 }
 {
  VM vm;
  GameModule game(&vm);
  game.startup();
  game.handleEscapeKey();
  assert(vm.quit && neverhood_demo_state == 3 && !game._mainMenuRequested);
 }
 std::puts("demo native guards passed");
}
