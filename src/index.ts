process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

console.log('ELECTRON', process.versions.electron, 'NODE', process.versions.node, 'ARCH', process.arch)

import { BrowserWindow, app, ipcMain, globalShortcut, IpcMainEvent, WebContents } from 'electron';
import AyayaLeague from './LeagueReader';
import { createOverlayWindow, createSettingsWindow } from './overlay/Windows'
import { loadSettingsFromFile, setSettings, saveSettingsToFile, getSettings } from './overlay/Settings'
import { Settings } from './overlay/models/Settings';
import { Vector2 } from './models/Vector';
import { Preparator } from './overlay/Preparator';
import { matrixToArray } from './utils/Utils';
import { Performance } from './utils/Performance';
import { UserScriptManager } from '../scripts/UserScriptManager';
import { CachedClass } from './models/CachedClass';
import ActionControllerWrapper from './ActionControllerWrapper';

import * as path from 'path';
import * as fs from 'fs';
import * as child from 'child_process';
import * as fetch from 'node-fetch';
import { Missile } from './models/Missile';

if (process.argv[2] == 'nohook') {
    AyayaLeague.reader.setMode("DUMP");
    AyayaLeague.reader.loadDump();
} else {
    AyayaLeague.reader.hookLeagueProcess();
}

const preparator = new Preparator(AyayaLeague);

let overlayWindow: BrowserWindow;
let settingsWindow: BrowserWindow;

let highestReadTime = 0;

let renderer: number;
let screen: Vector2;
let ticks = 1;

const threads: child.ChildProcess[] = [];

const userScripts: { _modulename: string, setup?: () => Promise<any>, onTick?: (e: UserScriptManager, t: number) => Promise<any>, onMissileCreate?: (m: Missile, e: UserScriptManager) => Promise<any> }[] = []

function sendMessageToWin(win: BrowserWindow | WebContents, name: string, data: any) {
    if (win['webContents']) return (win as BrowserWindow).webContents.send(name, JSON.stringify(data));
    return (win as WebContents).send(name, JSON.stringify(data));
}
function onMessage<T>(name: string, cb: (e: IpcMainEvent, message: T) => void) {
    ipcMain.on(name, (e, message) => {
        if (message == undefined || message == 'undefined') return cb(e, undefined);
        cb(e, JSON.parse(message));
    });
}
function registerHandlers() {

    onMessage<Settings>('updateSettings', (e, data) => {
        setSettings(data);
        saveSettingsToFile();
        sendMessageToWin(overlayWindow, 'dataSettings', data);
        sendMessageToWin(settingsWindow, 'dataSettings', data);
    });

    onMessage<never>('requestSettings', (e, data) => {
        const settings = getSettings();
        sendMessageToWin(e.sender, 'dataSettings', settings);
    });

    onMessage<never>('requestScreenSize', (e, data) => {
        renderer = renderer || AyayaLeague.getRenderBase();
        screen = screen || AyayaLeague.getScreenSize(renderer);
        sendMessageToWin(e.sender, 'dataScreenSize', screen);
    });

    onMessage<never>('closeSettingsWindow', (e, data) => {
        settingsWindow.hide();
    });


    onMessage<never>('reloadScripts', async (e, data) => {
        await unloadUserScripts();
        await loadUserScripts();
    });

    onMessage<never>('reloadWindows', (e, data) => {
        overlayWindow.reload();
        settingsWindow.reload();
    });

    onMessage<never>('openOverlayDevTools', (e, data) => {
        overlayWindow.webContents.openDevTools();
    });
}

async function loadUserScripts() {
    const basePath = path.join(__dirname, '../../scripts/userscripts');
    const userScriptsPaths = fs.readdirSync(basePath);
    for (const scriptPath of userScriptsPaths) {
        try {
            if (scriptPath.endsWith('.ts')) {
                console.log('Skipped', scriptPath, ' - You need to compile it to js');
                continue;
            }
            const p = path.join(basePath, scriptPath);
            const imp = await require(p);
            userScripts.push({ ...imp, _modulename: p });
        } catch (ex) {
            console.error('Error loading', scriptPath, ex);
        }
    }

    for (const script of userScripts) {
        try {
            script.setup && await script.setup();
        } catch (ex) {
            console.error('Error on script', script._modulename, 'function setup\n', ex);
        }
    }

    console.log('Loaded', userScripts.length, 'user scripts.');
}

async function unloadUserScripts() {
    for (const script of userScripts) {
        delete require.cache[script._modulename];
    }

    userScripts.length = 0;
}

async function main() {

    //* Read webapi data

    const webapi_interval = setInterval(async () => {
        const res = await fetch(`https://127.0.0.1:2999/liveclientdata/activeplayer`);
        const data = await res.json();
        CachedClass.set('webapi_me', data);
    }, 500);

    CachedClass.set('webapi_interval', webapi_interval);


    loadSettingsFromFile();
    registerHandlers();

    overlayWindow = createOverlayWindow();
    settingsWindow = createSettingsWindow();

    renderer = AyayaLeague.getRenderBase();
    screen = AyayaLeague.getScreenSize(renderer);
    overlayWindow.setSize(screen.x, screen.y);

    //* SHORTCUTS
    globalShortcut.register('CommandOrControl+Space', () => {
        settingsWindow.isVisible() ? settingsWindow.hide() : settingsWindow.show();
    });


    //* Load user scripts
    await loadUserScripts();


    //* Start loop
    loop();

}

const performance = new Performance();



let persistentMissiles: Missile[] = [];

async function loop() {
    performance.start();

    //* Create UserScriptManager
    const manager = new UserScriptManager();

    //* Load required global variables
    const gameTime = AyayaLeague.getGameTime();
    const me = manager.me;
    const myTeam = me.team;
    const nmeTeam = myTeam == 100 ? 200 : 100;
    const matrix = matrixToArray(AyayaLeague.getViewProjectionMatrix());

    //* Put global variables into global cache
    CachedClass.set('screen', screen);
    CachedClass.set('matrix', matrix);
    CachedClass.set('gameTime', gameTime);
    CachedClass.set('myTeam', myTeam);
    CachedClass.set('nmeTeam', nmeTeam);


    //* Check missiles for onMissileCreate function
    manager.missiles.forEach(missile => {

        // If missile is inside persistent skip
        if (persistentMissiles.find(m => m.address == missile.address)) return;

        // Otherwise notify every script for the new missile
        userScripts.forEach(s => {
            try {
                s.onMissileCreate && s.onMissileCreate(missile, manager)
            } catch (ex) {
                console.error('Error on script', s._modulename, 'function onMissileCreate\n', ex);
            }
        });

        // Add it to persistent
        persistentMissiles.push(missile);
    });

    // Remove deleted missiles from persistent
    persistentMissiles = persistentMissiles.filter(m => manager.missiles.find(e => e.address == m.address));




    const finalData = {
        me: preparator.prepareChampion(me),
        enemyChampions: manager.champions.enemies.map(e => preparator.prepareChampion(e)),
        missiles: manager.missiles.map(preparator.prepareMissile),
        performance: { time: 0, max: parseFloat(highestReadTime.toFixed(1)) },
        screen,
        matrix,
    }


    for (const userScript of userScripts) {
        try {
            await userScript.onTick(manager, ticks);
        } catch (ex) {
            console.error('Error on script', userScript._modulename, 'function onTick\n', ex);
        }
    }

    // --- performance ---
    const result = performance.end();
    if (result.time > highestReadTime) highestReadTime = result.time;
    // --- performance ---

    finalData.performance.time = result.time;
    sendMessageToWin(overlayWindow, 'gameData', finalData);
    const settings = getSettings();
    ticks++;
    setTimeout(loop, Math.max(result.time + settings.root.readingTime, 10));
}

app.whenReady().then(main);


app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    threads.forEach(t => t.kill());
});