import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test process gets its own data folder. Sharing `data/` meant one process's finished
// move removed the empty move-copies folder another had just made, and that move failed with
// ENOENT (HB-0494). A real install is one process, and copiesUnderWay guards it there.
process.env.HATCHABOT_DB ??= join(tmpdir(), `hatchabot-test-data-${process.pid}`, 'hatchabot.sqlite');
