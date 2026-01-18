/* eslint-disable linebreak-style */
"use strict";

var utils = require("../utils");

module.exports = function (defaultFuncs, api, ctx) {
    return function (text, threadID, messageID, callback) {

        // Promise support
        let resolveFunc = function () { };
        let rejectFunc = function () { };

        const returnPromise = new Promise((resolve, reject) => {
            resolveFunc = resolve;
            rejectFunc = reject;
        });

        // messageID আসলে callback হলে fix
        if (
            !callback &&
            (utils.getType(messageID) === "Function" ||
             utils.getType(messageID) === "AsyncFunction")
        ) {
            callback = messageID;
            messageID = undefined;
        }

        // callback না থাকলে promise ব্যবহার
        if (!callback) {
            callback = function (err, data) {
                if (err) return rejectFunc(err);
                resolveFunc(data);
            };
        }

        // Base payload
        const Payload = {
            thread_id: threadID,
            otid: utils.generateOfflineThreadingID(),
            source: 524289,
            send_type: 1,
            sync_group: 1,
            mark_thread_read: 0,
            text: typeof text === "string" && text.trim() ? text : " ",
            initiating_source: 0
        };

        // Reply payload (শুধু valid messageID থাকলে)
        if (messageID !== undefined && messageID !== null) {
            Payload.reply_metadata = {
                reply_source_id: messageID,
                reply_source_type: 1,
                reply_type: 0
            };
        }

        // MQTT Form
        const Form = JSON.stringify({
            app_id: "2220391788200892",
            payload: JSON.stringify({
                tasks: [
                    {
                        label: 46,
                        payload: JSON.stringify(Payload),
                        queue_name: threadID,
                        task_id: Math.floor(Math.random() * 1000000),
                        failure_count: null
                    }
                ],
                epoch_id: utils.generateOfflineThreadingID(),
                version_id: "7553237234719461"
            }),
            request_id: ++ctx.req_ID,
            type: 3
        });

        // MQTT publish
        ctx.mqttClient.publish(
            "/ls_req",
            Form,
            { qos: 1, retain: false },
            (err) => {
                if (err) return callback(err);
            }
        );

        // Callback register
        ctx.callback_Task[ctx.req_ID] = {
            callback,
            type: "sendMqttMessage"
        };

        return returnPromise;
    };
};
