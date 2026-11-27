import { afterEach } from 'vitest';
import { forgetAllReservationsForTests } from '../../src/orchestrator/lifecycle/reservations.js';

// Each test starts with no agent held (HB-0873). The reservations (the busy
// flag) are the process's memory, and every test of a file runs in one
// process: an agent marked busy in one test, or left busy by work that test
// started, was still busy in the next test's world when its agent had the
// same id ("a1"), which then met a 409 it never set up. In every test file
// (vitest.config.ts's setupFiles), after the file's own afterEach hooks.
// A test that makes several worlds lets go of what it held itself.
afterEach(() => { forgetAllReservationsForTests(); });
