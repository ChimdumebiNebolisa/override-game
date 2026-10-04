import { openDatabase } from './db';
import { metricsReport } from './metrics';

const db = openDatabase();
try {
  process.stdout.write(`${JSON.stringify(metricsReport(db), null, 2)}\n`);
} finally {
  db.close();
}
