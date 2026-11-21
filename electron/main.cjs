const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');

// Prevent Alt/menu accelerators from eating cab keys (R, T, etc.)
Menu.setApplicationMenu(null);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'ION LRT Simulator',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  const { installMapCache } = require('./map-cache.cjs');
  installMapCache(ipcMain, path.join(app.getPath('userData'), 'map-cache'), () => mainWindow?.webContents);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
