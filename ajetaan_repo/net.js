// ════════════════════════════════════════════════════════════
//  net.js — lightweight shared-world multiplayer over public MQTT
//  Everyone who opens the game joins the same room and sees each
//  other's cars. No account / server needed (public broker).
//  Fails gracefully to single-player if the broker is unreachable.
// ════════════════════════════════════════════════════════════
const ROOM  = 'aaretontie/v1';
const TOPIC = ROOM + '/pos';
const BYE   = ROOM + '/bye';
const CHAT  = ROOM + '/chat';
const myId  = Math.random().toString(36).slice(2, 10);

let client = null;
let connected = false;
let onPeer = () => {};
let onBye  = () => {};
let onChatMsg = () => {};
let lastMsgTime = 0;
let pingRtt = 0;
let _pingReqTime = 0;

(async () => {
    let mqtt;
    try { mqtt = (await import('mqtt')).default; }
    catch (e) { console.warn('[net] mqtt unavailable — single player only'); return; }
    try {
        client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
            clientId: 'aaretontie_' + myId,
            reconnectPeriod: 4000,
            connectTimeout: 8000,
            clean: true,
            keepalive: 10
        });
        client.on('connect', () => { connected = true; lastMsgTime = Date.now(); client.subscribe([TOPIC, BYE, CHAT]); });
        client.on('reconnect', () => { connected = false; });
        client.on('close',    () => { connected = false; });
        client.on('error',    () => {});
        client.on('packetsend', p => { if (p.cmd === 'pingreq') _pingReqTime = Date.now(); });
        client.on('packetreceive', p => { lastMsgTime = Date.now(); if (p.cmd === 'pingresp' && _pingReqTime) { pingRtt = Date.now() - _pingReqTime; _pingReqTime = 0; } });
        client.on('message', (t, buf) => {
            let d; try { d = JSON.parse(buf.toString()); } catch (e) { return; }
            if (!d || d.id === myId) return;
            if (t === CHAT) onChatMsg(d);
            else if (t === BYE) onBye(d.id);
            else onPeer(d);
        });
        addEventListener('beforeunload', () => {
            try { client.publish(BYE, JSON.stringify({ id: myId })); } catch (e) {}
        });
    } catch (e) { console.warn('[net] connect failed — single player only'); }
})();

export function setHandlers(peer, bye) { onPeer = peer || onPeer; onBye = bye || onBye; }
export function setChatHandler(h) { onChatMsg = h || onChatMsg; }
export function publishChat(text, name) {
    if (!client || !connected) return;
    try { client.publish(CHAT, JSON.stringify({ id: myId, n: name || '', t: text })); } catch (e) {}
}
export function publish(state) {
    if (!client || !connected) return;
    state.id = myId;
    try { client.publish(TOPIC, JSON.stringify(state)); } catch (e) {}
}
export function isConnected() { return connected; }
export { myId, lastMsgTime, pingRtt };
