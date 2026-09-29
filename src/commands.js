const SUB = 1, STRING = 3, INTEGER = 4, CHANNEL = 7, ROLE = 8;

export const command = {
  name: 'quest',
  description: 'West Marches quest coordination',
  contexts: [0], // guild only
  options: [
    {
      type: SUB,
      name: 'create',
      description: 'Post a quest and gather a party',
      options: [
        { type: STRING, name: 'title', description: 'Quest name', required: true, max_length: 80 },
        { type: STRING, name: 'description', description: 'Hook, location, level range, etc.', max_length: 1000 },
        { type: INTEGER, name: 'max', description: 'Max party size (default 5)', min_value: 1, max_value: 25 },
      ],
    },
    {
      type: SUB,
      name: 'edit',
      description: 'Change your quest (run in the quest channel, or anywhere for your latest open quest)',
      options: [
        { type: STRING, name: 'title', description: 'New quest name', max_length: 80 },
        { type: STRING, name: 'description', description: 'New description', max_length: 1000 },
        { type: INTEGER, name: 'max', description: 'New max party size', min_value: 1, max_value: 25 },
      ],
    },
    { type: SUB, name: 'close', description: 'End this quest and delete its party channels (run inside the quest channel)' },
    {
      type: SUB,
      name: 'setup',
      description: 'Admin: set the quest board channel and GM role',
      options: [
        { type: CHANNEL, name: 'board', description: 'Where quests get posted', channel_types: [0] },
        { type: ROLE, name: 'gm_role', description: 'Role that can see every party channel and close quests' },
      ],
    },
  ],
};
