import {it,expect} from 'vitest';
import {parseSwapProbe,dockerMemorySwap} from '../src/orchestrator/swap.js';
it('mixed zram and disk swap withholds the agent allowance regardless of priority',()=>{
 const s=parseSwapProbe(`zswap.enabled=N
--swaps
Filename Type Size Used Priority
/swapfile file 8388608 1048576 100
/dev/zram0 partition 1048576 0 5
--meminfo
--zram
zram.zram0.algo=lzo [zstd]
zram.zram0.mm=0 0 0
--end`);
 expect(s).toMatchObject({kind:'none',compressed:false});
 expect(s.swapDevices.find(x=>x.name==='/swapfile')!.priority).toBeGreaterThan(s.swapDevices.find(x=>x.name==='/dev/zram0')!.priority);
 expect(dockerMemorySwap('3g','2g',s.compressed)).toBe('3g');
});
