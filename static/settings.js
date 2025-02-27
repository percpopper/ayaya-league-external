
const { ipcRenderer } = require('electron');

const state = Vue.reactive({
    settings: {
        me: { range: true },
        nmeChamps: { range: true },
        over: { nmeSpells: true, performance: true },
        root: { readingTime: 3000 },
        missiles: { show: true }
    },
});

// ----- Settings -----
ipcRenderer.on('dataSettings', function (evt, message) {
    const data = JSON.parse(message);
    state.settings = data;
});
ipcRenderer.send('requestSettings');


const app = Vue.createApp({
    data() { return state; },
    methods: {
        updateSettings() {
            ipcRenderer.send('updateSettings', JSON.stringify(state.settings));
        },
        closeWindow() {
            ipcRenderer.send('closeSettingsWindow');
        },
        reloadWindows() {
            ipcRenderer.send('reloadWindows');
        },
        openOverlayDevTools() {
            ipcRenderer.send('openOverlayDevTools');
        },
        reloadScripts() {
            ipcRenderer.send('reloadScripts');
        }
    }
});

app.mount('#app')