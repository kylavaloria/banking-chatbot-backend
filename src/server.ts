import { env } from './config/env';
import app from './app';

const PORT = Number(env.PORT);

app.listen(PORT, () => {
  console.log(`BFSI Chatbot backend running on http://localhost:${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  GET  /api/me`);
  console.log(`  POST /api/chat/session`);
  console.log(`  POST /api/chat/message`);
  console.log(`  POST /api/dev/create-demo-case`);
});