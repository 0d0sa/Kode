import pino from 'pino';

/** Silent in-memory-free logger for unit tests; never touches ~/.kode/logs. */
export const testLogger = pino({ level: 'silent' });
