import { requireManager } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const manager = await requireManager(req, res);
  if (!manager) return;
  return res.status(200).json({ id: manager.id, email: manager.email });
}
