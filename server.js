const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json());
app.use(express.static('.'));

// Настройки
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_DIR = path.join(__dirname, 'data');

// Инициализация папки data
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Классы для работы с данными
class Database {
  constructor(filename) {
    this.filename = path.join(DATA_DIR, filename);
    this.init();
  }

  init() {
    if (!fs.existsSync(this.filename)) {
      fs.writeFileSync(this.filename, JSON.stringify([]));
    }
  }

  read() {
    try {
      const data = fs.readFileSync(this.filename, 'utf8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  write(data) {
    fs.writeFileSync(this.filename, JSON.stringify(data, null, 2));
  }

  getAll() {
    return this.read();
  }

  add(item) {
    const data = this.read();
    data.push(item);
    this.write(data);
    return item;
  }

  update(id, updates) {
    const data = this.read();
    const index = data.findIndex(item => item.id === id);
    if (index !== -1) {
      data[index] = { ...data[index], ...updates };
      this.write(data);
      return data[index];
    }
    return null;
  }

  delete(id) {
    const data = this.read();
    const filtered = data.filter(item => item.id !== id);
    this.write(filtered);
  }

  findOne(predicate) {
    return this.read().find(predicate);
  }

  findMany(predicate) {
    return this.read().filter(predicate);
  }
}

// Инициализация баз данных
const users = new Database('users.json');
const messages = new Database('messages.json');
const chats = new Database('chats.json');
const bans = new Database('bans.json');
const settings = new Database('settings.json');

// Инициализация админа при первом запуске
function initializeAdmin() {
  const adminExists = users.findOne(u => u.username === ADMIN_USERNAME);
  if (!adminExists) {
    const hashedPassword = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    users.add({
      id: Date.now().toString(),
      username: ADMIN_USERNAME,
      password: hashedPassword,
      displayName: 'Administrator',
      avatar: 'https://i.pravatar.cc/150?img=1',
      status: 'offline',
      bio: 'System Administrator',
      isAdmin: true,
      coins: 1000,
      lastLogin: new Date().toISOString(),
      lastIP: '127.0.0.1',
      createdAt: new Date().toISOString(),
      banned: false
    });
    console.log('✅ Администратор создан:', ADMIN_USERNAME);
  }
}

// Утилиты
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function isUserBanned(userId) {
  const ban = bans.findOne(b => b.userId === userId);
  if (!ban) return false;
  if (ban.expiresAt && new Date(ban.expiresAt) < new Date()) {
    bans.delete(ban.id);
    return false;
  }
  return true;
}

function getChatId(userId1, userId2) {
  const sorted = [userId1, userId2].sort();
  return `chat_${sorted[0]}_${sorted[1]}`;
}

// API маршруты
app.post('/api/register', (req, res) => {
  const { username, password, repeatPassword, displayName } = req.body;

  if (!username || !password || !repeatPassword || !displayName) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }

  if (password !== repeatPassword) {
    return res.status(400).json({ error: 'Пароли не совпадают' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: 'Логин должен быть минимум 3 символа' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
  }

  const userExists = users.findOne(u => u.username === username);
  if (userExists) {
    return res.status(400).json({ error: 'Этот логин уже занят' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);
  const newUser = {
    id: Date.now().toString(),
    username,
    password: hashedPassword,
    displayName,
    avatar: `https://i.pravatar.cc/150?u=${username}`,
    status: 'online',
    bio: '',
    isAdmin: false,
    coins: 100,
    lastLogin: new Date().toISOString(),
    lastIP: req.ip || '0.0.0.0',
    createdAt: new Date().toISOString(),
    banned: false
  };

  users.add(newUser);

  res.json({
    success: true,
    message: 'Пользователь зарегистрирован',
    user: {
      id: newUser.id,
      username: newUser.username,
      displayName: newUser.displayName,
      avatar: newUser.avatar
    }
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  const user = users.findOne(u => u.username === username);
  if (!user) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  if (isUserBanned(user.id)) {
    const ban = bans.findOne(b => b.userId === user.id);
    return res.status(403).json({ 
      error: `Пользователь заблокирован. Причина: ${ban.reason || 'Не указана'}`
    });
  }

  const passwordValid = bcrypt.compareSync(password, user.password);
  if (!passwordValid) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  users.update(user.id, {
    lastLogin: new Date().toISOString(),
    lastIP: req.ip || '0.0.0.0',
    status: 'online'
  });

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      status: 'online',
      bio: user.bio,
      isAdmin: user.isAdmin,
      coins: user.coins,
      createdAt: user.createdAt
    }
  });
});

app.get('/api/users', (req, res) => {
  const query = req.query.search?.toLowerCase() || '';
  const allUsers = users.getAll();
  
  let result = allUsers.map(u => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatar: u.avatar,
    status: u.status,
    coins: u.coins
  }));

  if (query) {
    result = result.filter(u => 
      u.username.toLowerCase().includes(query) || 
      u.displayName.toLowerCase().includes(query)
    );
  }

  res.json(result);
});

app.get('/api/user/:id', (req, res) => {
  const user = users.findOne(u => u.id === req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    status: user.status,
    bio: user.bio,
    coins: user.coins,
    createdAt: user.createdAt,
    isAdmin: user.isAdmin
  });
});

app.post('/api/user/profile/:userId', (req, res) => {
  const { displayName, avatar, bio } = req.body;
  const userId = req.params.userId;

  const user = users.findOne(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  const updates = {};
  if (displayName) updates.displayName = displayName;
  if (avatar) updates.avatar = avatar;
  if (bio !== undefined) updates.bio = bio;

  const updated = users.update(userId, updates);
  io.emit('userUpdated', {
    id: updated.id,
    displayName: updated.displayName,
    avatar: updated.avatar
  });

  res.json({
    success: true,
    user: {
      id: updated.id,
      username: updated.username,
      displayName: updated.displayName,
      avatar: updated.avatar,
      bio: updated.bio
    }
  });
});

app.post('/api/user/password/:userId', (req, res) => {
  const { oldPassword, newPassword, repeatPassword } = req.body;
  const userId = req.params.userId;

  const user = users.findOne(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  if (newPassword !== repeatPassword) {
    return res.status(400).json({ error: 'Новые пароли не совпадают' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
  }

  const passwordValid = bcrypt.compareSync(oldPassword, user.password);
  if (!passwordValid) {
    return res.status(401).json({ error: 'Текущий пароль неверный' });
  }

  const hashedPassword = bcrypt.hashSync(newPassword, 10);
  users.update(userId, { password: hashedPassword });

  res.json({ success: true, message: 'Пароль изменен' });
});

app.get('/api/chats/:userId', (req, res) => {
  const userId = req.params.userId;
  const userChats = chats.findMany(c => 
    c.user1 === userId || c.user2 === userId
  );

  const result = userChats.map(chat => {
    const otherId = chat.user1 === userId ? chat.user2 : chat.user1;
    const otherUser = users.findOne(u => u.id === otherId);
    const lastMsg = messages.findMany(m => m.chatId === chat.id).pop();

    return {
      id: chat.id,
      userId: otherId,
      username: otherUser?.username,
      displayName: otherUser?.displayName,
      avatar: otherUser?.avatar,
      lastMessage: lastMsg?.text || '',
      lastMessageTime: lastMsg?.timestamp,
      unread: chat.unreadCount || 0
    };
  }).sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

  res.json(result);
});

app.post('/api/chat/start', (req, res) => {
  const { userId, otherId } = req.body;

  const chatId = getChatId(userId, otherId);
  let chat = chats.findOne(c => c.id === chatId);

  if (!chat) {
    chat = {
      id: chatId,
      user1: userId,
      user2: otherId,
      createdAt: new Date().toISOString(),
      unreadCount: 0
    };
    chats.add(chat);
  }

  res.json({ success: true, chatId });
});

app.get('/api/messages/:chatId', (req, res) => {
  const chatId = req.params.chatId;
  const chatMessages = messages.findMany(m => m.chatId === chatId)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  res.json(chatMessages);
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (username !== ADMIN_USERNAME) {
    return res.status(401).json({ error: 'Неверные учетные данные администратора' });
  }

  if (!bcrypt.compareSync(password, bcrypt.hashSync(ADMIN_PASSWORD, 10))) {
    const adminUser = users.findOne(u => u.username === ADMIN_USERNAME);
    if (!adminUser || !bcrypt.compareSync(password, adminUser.password)) {
      return res.status(401).json({ error: 'Неверные учетные данные администратора' });
    }
  }

  res.json({
    success: true,
    admin: {
      username: ADMIN_USERNAME,
      isAdmin: true
    }
  });
});

app.get('/api/admin/users', (req, res) => {
  const adminUser = users.findOne(u => u.username === req.query.username);
  if (!adminUser?.isAdmin) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  const allUsers = users.getAll().map(u => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatar: u.avatar,
    status: u.status,
    coins: u.coins,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
    lastIP: u.lastIP,
    banned: u.banned
  }));

  res.json(allUsers);
});

app.post('/api/admin/user/ban', (req, res) => {
  const { userId, reason, duration } = req.body;
  const adminUsername = req.body.adminUsername;

  const admin = users.findOne(u => u.username === adminUsername);
  if (!admin?.isAdmin) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  const banId = Date.now().toString();
  const ban = {
    id: banId,
    userId,
    reason: reason || 'Нарушение правил',
    bannedAt: new Date().toISOString(),
    expiresAt: duration ? new Date(Date.now() + duration * 60 * 60 * 1000).toISOString() : null
  };

  bans.add(ban);
  users.update(userId, { banned: true });
  io.emit('userBanned', { userId });

  res.json({ success: true, ban });
});

app.post('/api/admin/user/unban', (req, res) => {
  const { userId } = req.body;
  const adminUsername = req.body.adminUsername;

  const admin = users.findOne(u => u.username === adminUsername);
  if (!admin?.isAdmin) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  const ban = bans.findOne(b => b.userId === userId);
  if (ban) {
    bans.delete(ban.id);
  }

  users.update(userId, { banned: false });
  io.emit('userUnbanned', { userId });

  res.json({ success: true });
});

app.post('/api/admin/user/coins', (req, res) => {
  const { userId, coins } = req.body;
  const adminUsername = req.body.adminUsername;

  const admin = users.findOne(u => u.username === adminUsername);
  if (!admin?.isAdmin) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  users.update(userId, { coins });
  io.emit('userCoinsUpdated', { userId, coins });

  res.json({ success: true, coins });
});

app.post('/api/admin/user/delete', (req, res) => {
  const { userId } = req.body;
  const adminUsername = req.body.adminUsername;

  const admin = users.findOne(u => u.username === adminUsername);
  if (!admin?.isAdmin) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  users.delete(userId);
  messages.getAll().forEach(m => {
    if (m.senderId === userId || m.receiverId === userId) {
      messages.delete(m.id);
    }
  });

  res.json({ success: true });
});

app.get('/api/admin/stats', (req, res) => {
  const adminUsername = req.query.username;
  const admin = users.findOne(u => u.username === adminUsername);
  if (!admin?.isAdmin) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  const allUsers = users.getAll();
  const onlineUsers = allUsers.filter(u => u.status === 'online').length;
  const bannedUsers = allUsers.filter(u => u.banned).length;
  const totalMessages = messages.getAll().length;

  res.json({
    totalUsers: allUsers.length,
    onlineUsers,
    bannedUsers,
    totalMessages,
    totalChats: chats.getAll().length
  });
});

app.get('/api/admin/messages', (req, res) => {
  const adminUsername = req.query.username;
  const admin = users.findOne(u => u.username === adminUsername);
  if (!admin?.isAdmin) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  const allMessages = messages.getAll().map(m => {
    const sender = users.findOne(u => u.id === m.senderId);
    return {
      id: m.id,
      senderName: sender?.displayName,
      text: m.text,
      timestamp: m.timestamp,
      chatId: m.chatId
    };
  });

  res.json(allMessages);
});

app.post('/api/admin/message/delete', (req, res) => {
  const { messageId } = req.body;
  const adminUsername = req.body.adminUsername;

  const admin = users.findOne(u => u.username === adminUsername);
  if (!admin?.isAdmin) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }

  messages.delete(messageId);
  io.emit('messageDeleted', { messageId });

  res.json({ success: true });
});

// WebSocket события
io.on('connection', (socket) => {
  console.log('🔌 Новое подключ��ние:', socket.id);

  socket.on('userOnline', (userId) => {
    const user = users.findOne(u => u.id === userId);
    if (user) {
      users.update(userId, { status: 'online' });
      io.emit('userStatusChanged', { userId, status: 'online' });
    }
  });

  socket.on('userOffline', (userId) => {
    const user = users.findOne(u => u.id === userId);
    if (user) {
      users.update(userId, { status: 'offline' });
      io.emit('userStatusChanged', { userId, status: 'offline' });
    }
  });

  socket.on('sendMessage', (data) => {
    const { chatId, senderId, text, replyTo } = data;

    const user = users.findOne(u => u.id === senderId);
    if (isUserBanned(senderId)) {
      socket.emit('error', 'Вы заблокированы');
      return;
    }

    const messageId = Date.now().toString();
    const newMessage = {
      id: messageId,
      chatId,
      senderId,
      text,
      timestamp: new Date().toISOString(),
      replyTo: replyTo || null,
      deleted: false
    };

    messages.add(newMessage);
    io.emit('newMessage', newMessage);
  });

  socket.on('deleteMessage', (data) => {
    const { messageId, senderId } = data;

    const message = messages.findOne(m => m.id === messageId);
    if (message && message.senderId === senderId) {
      messages.update(messageId, { deleted: true, text: '[Сообщение удалено]' });
      io.emit('messageDeleted', { messageId });
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ Отключение:', socket.id);
  });
});

// Запуск сервера
initializeAdmin();

const localIP = getLocalIP();
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   🚀 Nova Messenger сервер запущен   ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║ 📱 Локально: http://localhost:${PORT}${''.padEnd(14)} ║`);
  console.log(`║ 🌐 Сеть:     http://${localIP}:${PORT}${''.padEnd(17 - localIP.length)} ║`);
  console.log('╠════════════════════════════════════════╣');
  console.log('║ 👤 Админ:  admin / admin123            ║');
  console.log('╚════════════════════════════════════════╝\n');
});

process.on('SIGINT', () => {
  console.log('\n\n👋 Сервер остановлен');
  process.exit(0);
});
