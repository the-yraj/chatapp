/**
 * server.js - Chat Server
 * Express HTTP server + WebSocket server for real-time messaging
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const crypto = require('crypto');

// Import custom modules
const users = require('./users');
const sockets = require('./sockets');
const messages = require('./messages');

// Configuration
const PORT = process.env.PORT || 3000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'prototype-secret-key-change-in-prod';

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.static('public')); // Serve static files if needed

// HTTP Routes

/**
 * POST /login
 * Accepts { username, password }, validates and returns { token }
 */
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  // Validate credentials
  if (!users.validateUser(username, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Generate token (simple HMAC-based for prototype)
  const token = generateToken(username);
  
  console.log(`[LOGIN] User ${username} logged in`);
  res.json({ token, username });
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: Date.now(),
    connections: sockets.getOnlineUsers().length
  });
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

/**
 * WebSocket connection handler
 */
wss.on('connection', (ws, req) => {
  const params = url.parse(req.url, true).query;
  const { token, user: username } = params;

  // Validate token and username
  if (!token || !username) {
    console.log('[WS] Connection rejected: missing token or username');
    ws.close(4000, 'Missing token or username');
    return;
  }

  if (!validateToken(token, username)) {
    console.log(`[WS] Connection rejected: invalid token for ${username}`);
    ws.close(4001, 'Invalid token');
    return;
  }

  // Register user socket
  sockets.registerUser(username, ws);
  console.log(`[WS] User ${username} connected`);

  // Send presence updates to all users
  broadcastPresence(username, 'online');

  // Send any undelivered messages
  sendUndeliveredMessages(username, ws);

  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(username, message, ws);
    } catch (err) {
      console.error(`[WS] Error parsing message from ${username}:`, err);
      sendError(ws, 'Invalid message format');
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    sockets.unregisterUser(username);
    console.log(`[WS] User ${username} disconnected`);
    broadcastPresence(username, 'offline');
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error(`[WS] Error for ${username}:`, error.message);
  });
});

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(username, message, ws) {
  const { type } = message;

  switch (type) {
    case 'send_message':
      handleSendMessage(username, message);
      break;

    case 'ack_message':
      handleAckMessage(username, message);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

    default:
      console.log(`[WS] Unknown message type from ${username}:`, type);
      sendError(ws, `Unknown message type: ${type}`);
  }
}

/**
 * Handle send_message event
 */
function handleSendMessage(from, message) {
  const { clientMsgId, to, body, ts } = message;

  // Validate payload
  if (!clientMsgId || !to || !body) {
    console.error(`[MSG] Invalid send_message from ${from}:`, message);
    return;
  }

  // Generate server message ID
  const serverMsgId = generateMessageId();

  // Create message object
  const msg = {
    serverMsgId,
    clientMsgId,
    from,
    to,
    body,
    ts: ts || Date.now()
  };

  // Try to deliver immediately
  const recipientSocket = sockets.getSocket(to);
  
  if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
    // Recipient is online - send message
    recipientSocket.send(JSON.stringify({
      type: 'incoming_message',
      serverMsgId: msg.serverMsgId,
      from: msg.from,
      body: msg.body,
      ts: msg.ts
    }));

    // Store message temporarily (until ACK from recipient)
    messages.addMessage(msg);
    console.log(`[MSG] Delivered ${serverMsgId} from ${from} to ${to}`);
  } else {
    // Recipient is offline - store for later delivery
    messages.addMessage(msg);
    console.log(`[MSG] Stored ${serverMsgId} from ${from} to ${to} (recipient offline)`);
  }

  // Send ACK back to sender
  const senderSocket = sockets.getSocket(from);
  if (senderSocket && senderSocket.readyState === WebSocket.OPEN) {
    senderSocket.send(JSON.stringify({
      type: 'ack_message',
      serverMsgId: msg.serverMsgId,
      clientMsgId: msg.clientMsgId,
      to: msg.to
    }));
  }
}

/**
 * Handle ack_message event (from recipient)
 */
function handleAckMessage(username, message) {
  const { serverMsgId } = message;

  if (!serverMsgId) {
    console.error(`[ACK] Invalid ack_message from ${username}:`, message);
    return;
  }

  // Get the original message
  const msg = messages.getMessage(serverMsgId);
  
  if (msg && msg.to === username) {
    // Delete message from temporary store
    messages.removeMessage(serverMsgId);
    console.log(`[ACK] Message ${serverMsgId} acknowledged by ${username}, deleted from store`);
  } else {
    console.log(`[ACK] Message ${serverMsgId} not found or user mismatch`);
  }
}

/**
 * Send undelivered messages to user on connect
 */
function sendUndeliveredMessages(username, ws) {
  const undelivered = messages.getMessagesForUser(username);

  if (undelivered.length > 0) {
    console.log(`[MSG] Sending ${undelivered.length} undelivered messages to ${username}`);
    
    // Send as batch
    ws.send(JSON.stringify({
      type: 'undelivered_batch',
      messages: undelivered.map(msg => ({
        serverMsgId: msg.serverMsgId,
        from: msg.from,
        body: msg.body,
        ts: msg.ts
      }))
    }));
  }
}

/**
 * Broadcast presence update to all connected users
 */
function broadcastPresence(username, status) {
  const presenceUpdate = JSON.stringify({
    type: 'presence_update',
    user: username,
    status
  });

  sockets.getOnlineUsers().forEach(onlineUser => {
    if (onlineUser !== username) {
      const socket = sockets.getSocket(onlineUser);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(presenceUpdate);
      }
    }
  });
}

/**
 * Send error message to client
 */
function sendError(ws, error) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'error',
      error
    }));
  }
}

/**
 * Generate authentication token
 */
function generateToken(username) {
  const timestamp = Date.now();
  const payload = `${username}:${timestamp}`;
  const signature = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(payload)
    .digest('hex');
  
  return Buffer.from(`${payload}:${signature}`).toString('base64');
}

/**
 * Validate authentication token
 */
function validateToken(token, username) {
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [user, timestamp, signature] = decoded.split(':');

    // Check username matches
    if (user !== username) {
      return false;
    }

    // Verify signature
    const payload = `${user}:${timestamp}`;
    const expectedSignature = crypto
      .createHmac('sha256', TOKEN_SECRET)
      .update(payload)
      .digest('hex');

    if (signature !== expectedSignature) {
      return false;
    }

    // Check token age (optional - 24 hours for prototype)
    const age = Date.now() - parseInt(timestamp);
    if (age > 24 * 60 * 60 * 1000) {
      return false;
    }

    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Generate unique message ID
 */
function generateMessageId() {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

// Start server
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   Chat Server Started                ║
║   HTTP: http://localhost:${PORT}       ║
║   WebSocket: ws://localhost:${PORT}    ║
╚══════════════════════════════════════╝
  `);
  console.log(`[SERVER] Listening on port ${PORT}`);
  console.log(`[SERVER] Available users: ${users.getAllUsers().join(', ')}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM received, closing server...');
  server.close(() => {
    console.log('[SERVER] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[SERVER] SIGINT received, closing server...');
  server.close(() => {
    console.log('[SERVER] Server closed');
    process.exit(0);
  });
});

module.exports = server;
