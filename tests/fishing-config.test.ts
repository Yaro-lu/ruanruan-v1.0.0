import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.WCB_FISHING_GROUP_ID;
delete process.env.WCB_FISHING_GROUP_NAME;
const { FISHING_ROOM_ID, FISHING_ROOM_NAME, isFishingRoom, createFishingTools } = await import('../src/fishing.js');

test('an unconfigured installation does not bind fishing tools to any conversation', async () => {
  assert.equal(FISHING_ROOM_ID, '');
  assert.equal(FISHING_ROOM_NAME, '');
  for (const room of [undefined, '', '90000000001@chatroom']) {
    assert.equal(isFishingRoom('desktop-ruanruan', room), false);
    const tools = createFishingTools('desktop-ruanruan', room);
    assert.deepEqual(tools.specs, []);
    await assert.rejects(tools.call('fishing_knowledge', { query: '鲫鱼' }), /未启用/);
  }
});
