export const internalRoutes = (safeTitle) => `
// --- Internal Routes (Menu/Triggers) ---
// Note: All internal endpoints must start with /internal/

router.post('/api/realtime/message', async (req, res) => {
    try {
        const msg = req.body;
        // Broadcast to 'global_room' which clients subscribe to via connectRealtime
        await realtime.send('global_room', msg);
        res.json({ success: true });
    } catch(e) {
        console.error('[Server] Realtime Relay Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/internal/onInstall', async (req, res) => {
    console.log('App installed!');
    res.json({ success: true });
});

router.post('/internal/createPost', async (req, res) => {
    console.log('Creating game post...');
    
    try {
        // Use the global context object from @devvit/web/server, fallback to headers if needed
        const subredditName = context?.subredditName || req.headers['x-devvit-subreddit-name'];
        console.log('Context Subreddit:', subredditName);

        if (!subredditName) {
            return res.status(400).json({ error: 'Subreddit name is required (context/header missing)' });
        }

        const post = await reddit.submitCustomPost({
            title: '${safeTitle}',
            subredditName: subredditName,
            entry: 'default', // matches devvit.json entrypoint
            userGeneratedContent: {
                text: 'Play this game built with WebSim!'
            }
        });

        res.json({
            showToast: { text: 'Game post created!' },
            navigateTo: post
        });
    } catch (e) {
        console.error('Failed to create post:', e);
        res.status(500).json({ error: e.message });
    }
});
`;