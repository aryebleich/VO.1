// Each test process gets its own throwaway database and no outbound market-data calls.
import os from 'node:os';
import path from 'node:path';
process.env.DB_FILE = path.join(os.tmpdir(), `qp-test-${process.pid}-${Date.now()}.db`);
process.env.FREE_DATA = 'off';
