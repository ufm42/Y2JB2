const express = require("express");
const cors = require("cors");
const path = require("path");
const websocket = require("ws");

const PORT = 4747;

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
const server = app.listen(PORT, () => {
  const info = server.address();
  console.log(`Server running at http://${info.address}:${info.port}`);
});

const wss = new websocket.Server({ server });

wss.on("connection", (ws, req) => {
  console.log(`Client connected from ${req.socket.remoteAddress} !!`);

  ws.on("message", (msg) => console.log(msg.toString()));
  ws.on("close", () => console.log("Client disconnected"));
});
