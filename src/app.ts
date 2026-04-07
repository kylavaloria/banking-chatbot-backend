import express from 'express';
import cors from 'cors';
import meRoutes from './routes/me.routes';
import chatRoutes from './routes/chat.routes';
import devRoutes from './routes/dev.routes';
import agentRoutes from './routes/agent.routes';

const app = express();

app.use(cors());
app.use(express.json());

// Health check — no auth required.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/me', meRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/dev', devRoutes);
app.use('/api/agent', agentRoutes);

// Catch-all for unmatched routes.
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

export default app;