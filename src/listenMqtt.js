/* eslint-disable linebreak-style */
'use strict';

/* ================= REQUIRE ================= */

const utils = require('../utils');
const log = require('npmlog');
const mqtt = require('mqtt');
const WebSocket = require('ws');
const HttpsProxyAgent = require('https-proxy-agent');
const EventEmitter = require('events');
const Duplexify = require('duplexify');
const { Transform } = require('stream');

/* ================= GLOBAL ================= */

var identity = function () {};
var form = {};
var getSeqID = function () {};

global.Fca = global.Fca || {};
global.Fca.Data = global.Fca.Data || {};
global.Fca.Data.MsgCount = new Map();
global.Fca.Data.event = new Map();

/* ================= TOPICS ================= */

const topics = [
  '/ls_req',
  '/ls_resp',
  '/legacy_web',
  '/webrtc',
  '/rtc_multi',
  '/onevc',
  '/br_sr',
  '/sr_res',
  '/t_ms',
  '/thread_typing',
  '/orca_typing_notifications',
  '/notify_disconnect',
  '/orca_presence',
  '/inbox',
  '/mercury',
  '/messaging_events',
  '/orca_message_notifications',
  '/pp',
  '/webrtc_response'
];

/* ================= WEBSOCKET STREAM ================= */

function buildProxy(ws) {
  return new Transform({
    transform(chunk, enc, next) {
      if (ws.readyState === ws.OPEN) {
        ws.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      next();
    },
    flush(done) {
      try { ws.close(); } catch {}
      done();
    }
  });
}

function buildStream(ws, options) {
  const proxy = buildProxy(ws);
  const stream = Duplexify(undefined, undefined, options);

  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    stream.setReadable(proxy);
    stream.setWritable(proxy);
    stream.emit('connect');
  };

  ws.onmessage = evt => {
    const data = evt.data instanceof ArrayBuffer
      ? Buffer.from(evt.data)
      : Buffer.from(evt.data);
    stream.push(data);
  };

  ws.onerror = err => stream.destroy(err);
  ws.onclose = () => stream.destroy();

  return stream;
}

/* ================= MQTT LISTENER ================= */

function listenMqtt(defaultFuncs, api, ctx, globalCallback) {

  const sessionID = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const GUID = utils.getGUID();

  const username = {
    u: ctx.userID,
    s: sessionID,
    chat_on: ctx.globalOptions.online,
    fg: false,
    d: GUID,
    ct: 'websocket',
    aid: '219994525426954'
  };

  const cookies = ctx.jar
    .getCookies('https://www.facebook.com')
    .join('; ');

  const host = ctx.region
    ? `wss://edge-chat.facebook.com/chat?region=${ctx.region}&sid=${sessionID}&cid=${GUID}`
    : `wss://edge-chat.facebook.com/chat?sid=${sessionID}&cid=${GUID}`;

  const wsOptions = {
    headers: {
      Cookie: cookies,
      Origin: 'https://www.facebook.com',
      Referer: 'https://www.facebook.com/',
      'User-Agent': ctx.globalOptions.userAgent
    }
  };

  if (ctx.globalOptions.proxy) {
    wsOptions.agent = new HttpsProxyAgent(ctx.globalOptions.proxy);
  }

  const client = mqtt.connect(host, {
    protocol: 'ws',
    clientId: 'mqttwsclient',
    protocolVersion: 4,
    clean: true,
    keepalive: 60,
    reconnectPeriod: 5000,
    username: JSON.stringify(username),
    wsOptions,
    transformWsUrl: () => host,
    createWebsocket: () => {
      const ws = new WebSocket(host, wsOptions);
      return buildStream(ws);
    }
  });

  ctx.mqttClient = client;
  global.mqttClient = client;

  /* ===== CONNECT ===== */

  client.on('connect', () => {

    topics.forEach(t => client.subscribe(t));

    const queue = {
      sync_api_version: 11,
      max_deltas_able_to_process: 100,
      delta_batch_size: 500,
      encoding: 'JSON',
      entity_fbid: ctx.userID
    };

    if (ctx.lastSeqId) {
      queue.initial_titan_sequence_id = ctx.lastSeqId;
    }

    client.publish(
      '/messenger_sync_create_queue',
      JSON.stringify(queue),
      { qos: 1 }
    );

    globalCallback(null, { type: 'ready' });
  });

  /* ===== MESSAGE ===== */

  client.on('message', (topic, message) => {
    let json;
    try {
      json = JSON.parse(message.toString());
    } catch {
      return;
    }

    if (topic === '/t_ms') {
      if (json.lastIssuedSeqId) {
        ctx.lastSeqId = parseInt(json.lastIssuedSeqId);
      }

      if (Array.isArray(json.deltas)) {
        json.deltas.forEach(delta => {
          parseDelta(defaultFuncs, api, ctx, globalCallback, { delta });
        });
      }
    }

    if (topic === '/thread_typing' || topic === '/orca_typing_notifications') {
      globalCallback(null, {
        type: 'typ',
        from: json.sender_fbid?.toString(),
        isTyping: !!json.state,
        threadID: (json.thread || json.sender_fbid).toString()
      });
    }

    if (topic === '/orca_presence' && json.list) {
      json.list.forEach(p => {
        globalCallback(null, {
          type: 'presence',
          userID: p.u.toString(),
          timestamp: p.l * 1000,
          statuses: p.p
        });
      });
    }
  });

  client.on('error', err => log.error('MQTT', err));
  client.on('close', () => log.warn('MQTT', 'Disconnected'));
}

/* ================= DELTA PARSER ================= */

function parseDelta(defaultFuncs, api, ctx, globalCallback, { delta }) {

  /* ===== NEW MESSAGE ===== */
  if (delta.class === 'NewMessage') {
    let msg;
    try {
      msg = utils.formatDeltaMessage(delta);
    } catch {
      return;
    }

    if (!ctx.globalOptions.selfListen && msg.senderID === ctx.userID) return;

    if (ctx.globalOptions.autoMarkDelivery) {
      api.markAsDelivered(msg.threadID, msg.messageID, () => {
        if (ctx.globalOptions.autoMarkRead) {
          api.markAsRead(msg.threadID, () => {});
        }
      });
    }

    return globalCallback(null, msg);
  }

  /* ===== CLIENT PAYLOAD ===== */
  if (delta.class === 'ClientPayload') {
    const payload = utils.decodeClientPayload(delta.payload);
    if (!payload || !payload.deltas) return;

    for (const d of payload.deltas) {

      if (d.deltaMessageReaction) {
        globalCallback(null, {
          type: 'message_reaction',
          threadID: (
            d.deltaMessageReaction.threadKey.threadFbId ||
            d.deltaMessageReaction.threadKey.otherUserFbId
          ).toString(),
          messageID: d.deltaMessageReaction.messageId,
          reaction: d.deltaMessageReaction.reaction,
          senderID: d.deltaMessageReaction.senderId.toString(),
          userID: d.deltaMessageReaction.userId.toString()
        });
      }

      if (d.deltaRecallMessageData) {
        globalCallback(null, {
          type: 'message_unsend',
          threadID: (
            d.deltaRecallMessageData.threadKey.threadFbId ||
            d.deltaRecallMessageData.threadKey.otherUserFbId
          ).toString(),
          messageID: d.deltaRecallMessageData.messageID,
          senderID: d.deltaRecallMessageData.senderID.toString(),
          timestamp: d.deltaRecallMessageData.timestamp
        });
      }

      if (d.deltaMessageReply) {
        const msg = d.deltaMessageReply.message;
        if (!msg) continue;

        globalCallback(null, {
          type: 'message_reply',
          threadID: (
            msg.messageMetadata.threadKey.threadFbId ||
            msg.messageMetadata.threadKey.otherUserFbId
          ).toString(),
          messageID: msg.messageMetadata.messageId,
          senderID: msg.messageMetadata.actorFbId.toString(),
          body: msg.body || '',
          timestamp: parseInt(msg.messageMetadata.timestamp),
          isGroup: !!msg.messageMetadata.threadKey.threadFbId
        });
      }
    }
  }
}

/* ================= EXPORT ================= */

module.exports = function (defaultFuncs, api, ctx) {

  return function (callback) {

    class MessageEmitter extends EventEmitter {
      stopListening() {
        if (ctx.mqttClient) {
          ctx.mqttClient.end(true);
          ctx.mqttClient = null;
        }
      }
    }

    const emitter = new MessageEmitter();

    const globalCallback = (err, data) => {
      if (err) emitter.emit('error', err);
      else emitter.emit('message', data);
    };

    if (!ctx.firstListen) ctx.lastSeqId = null;
    ctx.firstListen = false;

    listenMqtt(defaultFuncs, api, ctx, globalCallback);

    return emitter;
  };
};
