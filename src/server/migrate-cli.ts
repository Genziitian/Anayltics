// `npm run migrate`: apply pending migrations and exit. (The server also migrates on start.)
import { db } from './db';
import { migrate } from './migrate';

migrate()
  .then(() => db.pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
