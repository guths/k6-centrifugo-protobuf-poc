import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.2.0/index.js";
import { check } from "k6";
import encoding from "k6/encoding";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import ws from "k6/ws";
import * as nb2 from "./newcentrifugo.js";

import { generateJWT } from "./utils.js";

const messagesReceived = new Counter("messages_received");
const messagesSent = new Counter("messages_sent");
const extraMessagesSent = new Counter("extra_messages_sent");
const extraMessagesReceived = new Counter("extra_messages_received");
const authSuccess = new Counter("auth_success");
const subscribeSuccess = new Counter("subscribe_success");
const connectionErrors = new Counter("connection_errors");
const connectLatency = new Trend("connect_latency");
const subscribeLatency = new Trend("subscribe_latency");
const durationMetric = new Trend("duration");
const reconnectionRate = new Rate("reconnection_rate");
const extraChannelsAmountMetric = new Counter("extra_channels_amount");
const userPerExtraChannelMetric = new Counter("user_per_extra_channel");

const jwtSecret = __ENV.JWT_SECRET;
const centrifugoWsUrl = __ENV.CENTRIFUGO_WS_URL;
const extraChannelsAmount = parseInt(__ENV.EXTRA_CHANNELS_AMOUNT || 0);
const userPerExtraChannel = parseInt(__ENV.USER_PER_EXTRA_CHANNEL || 0);
const apiKey = __ENV.API_KEY;
const centrifugoApiUrl = __ENV.CENTRIFUGO_API_URL;
const vus = __ENV.VUS || 50;

const namespace = "personal";

export const options = {
  scenarios: {
    listeners: {
      executor: "constant-vus",
      vus,
      duration: "10s",
      gracefulStop: "5s",
    },
  },
};

if (extraChannelsAmount >= vus) {
  console.error(
    `❌ Extra channels (${extraChannelsAmount}) cannot be greater than VUs (${vus}).`
  );
  throw new Error("Invalid configuration");
}

if (extraChannelsAmount > 0 && userPerExtraChannel <= 0) {
  console.error(
    `❌ Extra channels (${extraChannelsAmount}) require userPerExtraChannel to be greater than 0.`
  );
  throw new Error("Invalid configuration");
}

if (userPerExtraChannel * extraChannelsAmount > vus) {
  console.error(
    `❌ Extra channels (${extraChannelsAmount}) with userPerExtraChannel (${userPerExtraChannel}) cannot exceed VUs (${vus}).`
  );
  throw new Error("Invalid configuration");
}

export function setup() {
  durationMetric.add(parseInt(__ENV.DURATION || 10));
  if (extraChannelsAmount > 0) {
    extraChannelsAmountMetric.add(extraChannelsAmount);
    userPerExtraChannelMetric.add(userPerExtraChannel);
    console.log(`✅ Extra channels enabled. Amount: ${extraChannelsAmount}.`);
  }
}

export default function () {
  const startConnect = Date.now();
  const personalChannelName = `${namespace}:#user${__VU}`;
  const isFirstVU = __VU === 1;
  const allChannels = buildPersonalChannels();
  const extraChannels = buildExtraChannels();

  const connectionResult = ws.connect(
    `${centrifugoWsUrl}?format=protobuf&cf_ws_frame_ping_pong=true`,
    null,
    function (socket) {
      socket.on("open", () =>
        handleSocketOpen(
          socket,
          startConnect,
          personalChannelName,
          allChannels,
          extraChannels,
          isFirstVU
        )
      );
      socket.on("close", (code, reason) => handleSocketClose(code, reason));
      socket.on("error", (error) => handleSocketError(error));
      socket.on("message", (data) => handleSocketMessage(data));
      // socket.on("binaryMessage", (data) => handleBinaryMessage(data));
    }
  );

  console.log(`VU ${__VU}: Connection result:`, connectionResult);

  check(connectionResult, {
    "Connection status is 101 (Switching Protocols)": (r) =>
      r && r.status === 101,
  });
}

function handleSocketOpen(
  socket,
  startConnect,
  personalChannelName,
  allChannels,
  extraChannels,
  isFirstVU
) {
  const connectTime = Date.now() - startConnect;
  connectLatency.add(connectTime);

  const payload = {
    sub: `user${__VU}`,
    exp: 9590186316,
  };

  const jwtToken = generateJWT(payload, jwtSecret);

  const connectRequest = {
    id: 1,
    connect: { token: jwtToken }
  };

  const clientConnectMessage =
    nb2.centrifugal.centrifuge.protocol.Command.create(connectRequest);
  const encoded =
    nb2.centrifugal.centrifuge.protocol.Command.encodeDelimited(
      clientConnectMessage
    ).finish();

  socket.send(encoded);

  authSuccess.add(1);

  // Subscribe to personal channel
  const subscribeStart = Date.now();

  const subscribeRequest = {
    id: 2,
    subscribe: { channel: personalChannelName },
  };

  // const subscribeEncoded = pb.encodeClientMessage(subscribeRequest);

  // socket.sendBinary(typedArrayToBuffer(subscribeEncoded));

  // Subscribe to extra channel if needed
  // if (
  //   extraChannelsAmount > 0 &&
  //   __VU <= extraChannelsAmount * userPerExtraChannel
  // ) {
  //   const channel = Math.ceil(__VU / userPerExtraChannel);
  //   const extraChannelName = `extra${parseInt(channel)}`;

  //   const extraSubscribePayload = subscribeParams.create({
  //     channel: extraChannelName,
  //   });

  //   const extraSubscribeCommand = subscribeCmd.create({
  //     id: 3,
  //     subscribe: extraSubscribePayload,
  //   });

  //   const extraSubscribeBuffer = subscribeCmd
  //     .encode(extraSubscribeCommand)
  //     .finish();
  //   socket.sendBinary(extraSubscribeBuffer);
  // }

  subscribeSuccess.add(1);
  const subscribeTime = Date.now() - subscribeStart;
  subscribeLatency.add(subscribeTime);

  console.log(
    `VU ${__VU}: Subscribed to personal channel ${personalChannelName}`
  );

  socket.setInterval(function () {
    if (isFirstVU) {
      broadcastMessage(allChannels);
    }

    if (isFirstVU && extraChannelsAmount > 0) {
      broadcastMessage(extraChannels, true);
    }
  }, 1000);
}

function handleSocketClose(code, reason) {
  console.log(
    `VU ${__VU}: Connection closed. Code: ${code}, Reason: ${reason || "N/A"}`
  );
  if (code !== 1000) {
    reconnectionRate.add(1);
  }
}

function handleSocketError(error) {
  console.error(`VU ${__VU}: Connection error:`, error);
  connectionErrors.add(1);
}

function handleSocketMessage(data) {
  console.log(`VU ${__VU}: Received text message: ${data}`);
  // Text messages shouldn't occur with protobuf format, but handle just in case
}

function handleBinaryMessage(data) {
  try {
    // Decode the binary message using protobuf
    const reply = pb.decodeServerMessage(new Uint8Array(data));

    // Handle push messages (publications)
    if (reply.push && reply.push.pub && reply.push.pub.data) {
      try {
        // The data field contains encoded JSON
        const dataDecoded = JSON.parse(
          encoding.b64decode(reply.push.pub.data, "std", "s")
        );
        const uuid = dataDecoded.uuid;

        if (uuid) {
          if (reply.push.channel.includes("extra")) {
            extraMessagesReceived.add(1);
            console.log(
              `VU ${__VU}: Received broadcast message UUID: ${uuid} on channel ${reply.push.channel} (Extra channel)`
            );
          } else {
            messagesReceived.add(1);
          }
          console.log(
            `VU ${__VU}: Received broadcast message UUID: ${uuid} on channel ${reply.push.channel}`
          );
        }
      } catch (e) {
        console.error(`VU ${__VU}: Error decoding push data:`, e);
      }
    }

    // Handle other message types
    if (reply.connect) {
      console.log(
        `VU ${__VU}: Connected with client ID: ${reply.connect.client}`
      );
    }

    if (reply.subscribe) {
      console.log(`VU ${__VU}: Successfully subscribed to channel`);
    }
  } catch (e) {
    console.error(`VU ${__VU}: Error decoding protobuf message:`, e);
  }
}

function buildPersonalChannels() {
  const channels = [];
  for (let i = 1; i <= vus; i++) {
    channels.push(`${namespace}:#user${i}`);
  }

  return channels;
}

function buildExtraChannels() {
  const channels = [];
  for (let i = 1; i <= extraChannelsAmount; i++) {
    channels.push(`extra${i}`);
  }

  return channels;
}

function broadcastMessage(channels, isExtra = false) {
  const uuid = uuidv4();
  const timestamp = new Date().toISOString();

  const payload = {
    channels: channels,
    data: {
      uuid: uuid,
      text: `Message from VU ${__VU} at ${timestamp}`,
      timestamp: timestamp,
    },
  };

  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": `${apiKey}`,
  };

  const response = http.post(centrifugoApiUrl, JSON.stringify(payload), {
    headers,
  });

  if (response.status === 200) {
    if (isExtra) {
      extraMessagesSent.add(1);
    } else {
      messagesSent.add(1);
    }
    console.log(
      `✅ Broadcast message sent successfully. UUID: ${uuid} (Extra channel: ${isExtra})`
    );
  } else {
    console.error(
      `❌ Failed to send broadcast message. UUID: ${uuid}, Status: ${response.status}, Response: ${response.body}`
    );
  }
}

function typedArrayToBuffer(array) {
  return array.buffer.slice(
    array.byteOffset,
    array.byteLength + array.byteOffset
  );
}
