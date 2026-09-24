// Workbench contributions (feature entry point): application menus + Manage menu, project commands
// (New / Open Recent / Rename / Duplicate / Delete), Color Theme picker, Auto Save, Open View,
// Developer Tools, About, Check for Updates and Release Notes.

import { registerApplicationMenus } from './contrib/menubar.js';
import { registerProjectCommands } from './contrib/projects.js';
import { registerAppCommands } from './contrib/appCommands.js';

export async function activate() {
  registerProjectCommands();
  registerAppCommands();
  registerApplicationMenus();
}
