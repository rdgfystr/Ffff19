"use strict";

const utils = require("../utils");
const log = require("npmlog");
const bluebird = require("bluebird");

module.exports = function (defaultFuncs, api, ctx) {

  function uploadAttachment(attachments) {
    if (!Array.isArray(attachments)) attachments = [attachments];

    return bluebird.map(attachments, attachment => {
      if (!utils.isReadableStream(attachment)) {
        throw new Error("Attachment must be a readable stream");
      }

      const form = {
        upload_1024: attachment
      };

      return defaultFuncs
        .postFormData(
          "https://upload.facebook.com/ajax/mercury/upload.php",
          ctx.jar,
          form,
          {}
        )
        .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
        .then(res => {
          if (res.error) throw res;
          return res.payload.metadata[0];
        });
    });
  }

  function sendContent(form, threadID, callback) {
    // user chat
    if (String(threadID).length <= 16) {
      form["specific_to_list[0]"] = "fbid:" + threadID;
      form["specific_to_list[1]"] = "fbid:" + ctx.userID;
      form["other_user_fbid"] = threadID;
    }
    // group chat
    else {
      form["thread_fbid"] = threadID;
    }

    defaultFuncs
      .post("https://www.facebook.com/messaging/send/", ctx.jar, form)
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(res => {
        if (!res || res.error) return callback(res || { error: "Send failed" });

        const action = res.payload.actions[0];
        callback(null, {
          threadID: action.thread_fbid,
          messageID: action.message_id,
          timestamp: action.timestamp
        });
      })
      .catch(err => {
        log.error("sendMessage", err);
        callback(err);
      });
  }

  return function sendMessage(message, threadID, callback, replyToMessage) {
    if (!callback) {
      return new Promise((resolve, reject) => {
        sendMessage(message, threadID, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        }, replyToMessage);
      });
    }

    if (typeof message === "string") {
      message = { body: message };
    }

    const messageID = utils.generateOfflineThreadingID();

    const form = {
      client: "mercury",
      action_type: "ma-type:user-generated-message",
      author: "fbid:" + ctx.userID,
      timestamp: Date.now(),
      source: "source:chat:web",
      body: message.body || "",
      offline_threading_id: messageID,
      message_id: messageID,
      threading_id: utils.generateThreadingID(ctx.clientID),
      has_attachment: !!message.attachment,
      replied_to_message_id: replyToMessage
    };

    // handle mentions safely
    if (message.mentions && message.body) {
      message.mentions.forEach((m, i) => {
        const offset = message.body.indexOf(m.tag);
        if (offset < 0) return;

        form[`profile_xmd[${i}][offset]`] = offset;
        form[`profile_xmd[${i}][length]`] = m.tag.length;
        form[`profile_xmd[${i}][id]`] = m.id;
        form[`profile_xmd[${i}][type]`] = "p";
      });
    }

    // handle attachment
    if (message.attachment) {
      uploadAttachment(message.attachment)
        .then(files => {
          files.forEach(file => {
            const type = Object.keys(file)[0];
            form[`${type}s`] = [file[type]];
          });
          sendContent(form, threadID, callback);
        })
        .catch(callback);
    } else {
      sendContent(form, threadID, callback);
    }
  };
};
