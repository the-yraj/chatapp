/**
 * chat.js - WebSocket Chat Client
 * Handles connection, messaging, ACKs, and presence updates
 */

const ChatApp = (() => {
  let socket = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let seenMessageIds = new Set();
  let pendingMessages = new Map(); // clientMsgId -> DOM element
  
  const MAX_RECONNECT_ATTEMPTS = 5;
  const BASE_DELAY = 1000;
  
  // DOM elements (set during init)
  let elements = {};
  let currentUser = '';
  let selectedContact = '';

  /**
   * Initialize the chat application
   */
  function init(selectors) {
    elements = {
      messageInput: document.querySelector(selectors.messageInput),
      sendButton: document.querySelector(selectors.sendButton),
      messagesContainer: document.querySelector(selectors.messagesContainer),
      contactsList: document.querySelector(selectors.contactsList),
      currentChatName: document.querySelector(selectors.currentChatName),
      connectionStatus: document.querySelector(selectors.connectionStatus)
    };

    // Parse URL params for token and username
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    currentUser = params.get('user');

    if (!token || !currentUser) {
      showError('Missing token or user in URL');
      return;
    }

    // Set up event listeners
    elements.sendButton?.addEventListener('click', sendMessage);
    elements.messageInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    elements.contactsList?.addEventListener('click', (e) => {
      const contactItem = e.target.closest('[data-contact]');
      if (contactItem) {
        selectContact(contactItem.dataset.contact);
      }
    });

    // Connect to WebSocket
    connect(token, currentUser);
  }

  /**
   * Establish WebSocket connection
   */
  function connect(token, user) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.hostname;
    const port = location.port || (protocol === 'wss:' ? '443' : '80');
    const wsUrl = `${protocol}//${host}:${port}/?token=${token}&user=${user}`;

    updateConnectionStatus('Connecting...');

    try {
      socket = new WebSocket(wsUrl);
      
      socket.onopen = handleOpen;
      socket.onmessage = handleMessage;
      socket.onclose = handleClose;
      socket.onerror = handleError;
    } catch (err) {
      console.error('WebSocket connection error:', err);
      scheduleReconnect(token, user);
    }
  }

  /**
   * Handle WebSocket open event
   */
  function handleOpen() {
    console.log('WebSocket connected');
    reconnectAttempts = 0;
    updateConnectionStatus('Connected', true);
  }

  /**
   * Handle incoming WebSocket messages
   */
  function handleMessage(event) {
    try {
      const data = JSON.parse(event.data);
      const { type } = data;

      switch (type) {
        case 'incoming_message':
          handleIncomingMessage(data);
          break;
        
        case 'ack_message':
          handleAckMessage(data);
          break;
        
        case 'presence_update':
          handlePresenceUpdate(data);
          break;
        
        case 'undelivered_batch':
          handleUndeliveredBatch(data);
          break;
        
        default:
          console.warn('Unknown message type:', type);
      }
    } catch (err) {
      console.error('Error parsing message:', err);
    }
  }

  /**
   * Handle WebSocket close event
   */
  function handleClose(event) {
    console.log('WebSocket closed:', event.code, event.reason);
    updateConnectionStatus('Disconnected');
    
    // Reconnect if close was unexpected
    if (!event.wasClean && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const params = new URLSearchParams(location.search);
      scheduleReconnect(params.get('token'), params.get('user'));
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      updateConnectionStatus('Connection failed. Please refresh.');
    }
  }

  /**
   * Handle WebSocket error event
   */
  function handleError(error) {
    console.error('WebSocket error:', error);
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  function scheduleReconnect(token, user) {
    if (reconnectTimer) return;
    
    reconnectAttempts++;
    const delay = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempts - 1), 30000);
    
    updateConnectionStatus(`Reconnecting in ${Math.ceil(delay / 1000)}s...`);
    
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(token, user);
    }, delay);
  }

  /**
   * Send a message
   */
  function sendMessage() {
    const body = elements.messageInput?.value.trim();
    if (!body || !selectedContact) return;

    const clientMsgId = generateMessageId();
    const ts = Date.now();

    const message = {
      type: 'send_message',
      clientMsgId,
      to: selectedContact,
      body,
      ts
    };

    // Add to UI with pending state
    const messageElement = appendMessage({
      from: currentUser,
      to: selectedContact,
      body,
      ts,
      clientMsgId,
      pending: true
    });

    pendingMessages.set(clientMsgId, messageElement);

    // Send via WebSocket
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      elements.messageInput.value = '';
    } else {
      showError('Not connected. Message not sent.');
      messageElement.classList.add('failed');
    }
  }

  /**
   * Handle incoming message from server
   */
  function handleIncomingMessage(data) {
    const { serverMsgId, from, body, ts } = data;

    // Check for duplicates
    if (seenMessageIds.has(serverMsgId)) {
      console.log('Duplicate message ignored:', serverMsgId);
      return;
    }
    seenMessageIds.add(serverMsgId);

    // Append to UI
    appendMessage({
      from,
      to: currentUser,
      body,
      ts,
      serverMsgId,
      pending: false
    });

    // Send ACK back to server
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'ack_message',
        serverMsgId
      }));
    }
  }

  /**
   * Handle ACK from server (message delivered)
   */
  function handleAckMessage(data) {
    const { serverMsgId, clientMsgId } = data;

    if (clientMsgId && pendingMessages.has(clientMsgId)) {
      const messageElement = pendingMessages.get(clientMsgId);
      
      // Mark as delivered
      messageElement.classList.remove('pending');
      messageElement.classList.add('delivered');
      messageElement.dataset.serverMsgId = serverMsgId;
      
      pendingMessages.delete(clientMsgId);
    }
  }

  /**
   * Handle presence update
   */
  function handlePresenceUpdate(data) {
    const { user, status } = data;
    
    const contactElement = elements.contactsList?.querySelector(`[data-contact="${user}"]`);
    if (contactElement) {
      const statusDot = contactElement.querySelector('.status-dot');
      if (statusDot) {
        statusDot.className = `status-dot ${status}`;
        statusDot.title = status === 'online' ? 'Online' : 'Offline';
      }
    }
  }

  /**
   * Handle batch of undelivered messages (on reconnect)
   */
  function handleUndeliveredBatch(data) {
    const { messages } = data;
    
    if (messages && Array.isArray(messages)) {
      messages.forEach(msg => {
        handleIncomingMessage({
          type: 'incoming_message',
          serverMsgId: msg.serverMsgId,
          from: msg.from,
          body: msg.body,
          ts: msg.ts
        });
      });
    }
  }

  /**
   * Append message to UI
   */
  function appendMessage({ from, to, body, ts, clientMsgId, serverMsgId, pending }) {
    if (!elements.messagesContainer) return null;

    // Only show if relevant to current conversation
    const otherUser = from === currentUser ? to : from;
    if (selectedContact && otherUser !== selectedContact) {
      return null;
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${from === currentUser ? 'sent' : 'received'}`;
    
    if (pending) {
      messageDiv.classList.add('pending');
    }
    
    if (clientMsgId) {
      messageDiv.dataset.clientMsgId = clientMsgId;
    }
    
    if (serverMsgId) {
      messageDiv.dataset.serverMsgId = serverMsgId;
    }

    const timestamp = new Date(ts).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });

    messageDiv.innerHTML = `
      <div class="message-body">${escapeHtml(body)}</div>
      <div class="message-meta">
        <span class="message-time">${timestamp}</span>
        ${pending ? '<span class="message-status">⏳</span>' : ''}
      </div>
    `;

    elements.messagesContainer.appendChild(messageDiv);
    elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;

    return messageDiv;
  }

  /**
   * Select a contact and load their messages
   */
  function selectContact(contact) {
    selectedContact = contact;
    
    // Update UI
    if (elements.currentChatName) {
      elements.currentChatName.textContent = contact;
    }

    // Clear messages
    if (elements.messagesContainer) {
      elements.messagesContainer.innerHTML = '';
    }

    // Highlight selected contact
    elements.contactsList?.querySelectorAll('[data-contact]').forEach(el => {
      el.classList.toggle('active', el.dataset.contact === contact);
    });

    // Focus input
    elements.messageInput?.focus();
  }

  /**
   * Update connection status indicator
   */
  function updateConnectionStatus(message, isConnected = false) {
    if (elements.connectionStatus) {
      elements.connectionStatus.textContent = message;
      elements.connectionStatus.className = `connection-status ${isConnected ? 'connected' : 'disconnected'}`;
    }
  }

  /**
   * Show error message
   */
  function showError(message) {
    console.error(message);
    // Could add toast notification here
    alert(message);
  }

  /**
   * Generate unique message ID
   */
  function generateMessageId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Public API
  return {
    init
  };
})();

// Auto-initialize if DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    ChatApp.init({
      messageInput: '#message-input',
      sendButton: '#send-button',
      messagesContainer: '#messages',
      contactsList: '#contacts-list',
      currentChatName: '#current-chat-name',
      connectionStatus: '#connection-status'
    });
  });
} else {
  ChatApp.init({
    messageInput: '#message-input',
    sendButton: '#send-button',
    messagesContainer: '#messages',
    contactsList: '#contacts-list',
    currentChatName: '#current-chat-name',
    connectionStatus: '#connection-status'
  });
}
