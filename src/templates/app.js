export const getMainTs = (title) => {
    const safeTitle = title.replace(/'/g, "\\'");
    return `
import express from 'express';
import { Devvit } from '@devvit/public-api';
import { 
    createServer, 
    context, 
    getServerPort, 
    redis, 
    reddit,
    realtime,
    payments
} from '@devvit/web/server';
// Enable Realtime & Reddit API
Devvit.configure({
    redditAPI: true,
    realtime: true,
    http: true
});

const app = express();

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

const router = express.Router();

// --- Database Helpers ---
const DB_REGISTRY_KEY = 'sys:registry';

// Helper: Calculate total from order history (Self-healing)
async function recalculateUserTotal(userId) {
    try {
        // 1. Fetch all order IDs for user
        const orderIds = await redis.zRange(\`user_orders:\${userId}\`, 0, -1);
        if (!orderIds || orderIds.length === 0) return 0;

        // 2. Fetch order details
        let total = 0;
        const promises = orderIds.map(id => redis.get(\`order:\${id}\`));
        const results = await Promise.all(promises);
        
        results.forEach(r => {
            if (r) {
                const o = JSON.parse(r);
                if (o.amount) total += parseInt(o.amount) || 0;
            }
        });

        // 3. Heal the cache
        if (total > 0) {
            await redis.set(\`user_total:\${userId}\`, String(total));
        }
        return total;
    } catch (e) {
        console.warn("Recalculate total failed:", e);
        return 0;
    }
}

async function fetchAllData() {
    try {
        const collections = await redis.zRange(DB_REGISTRY_KEY, 0, -1);
        const dbData = {};

        await Promise.all(collections.map(async (item) => {
            const colName = typeof item === 'string' ? item : item.member;
            const raw = await redis.hGetAll(colName);
            const parsed = {};
            for (const [k, v] of Object.entries(raw)) {
                try { parsed[k] = JSON.parse(v); } catch(e) { parsed[k] = v; }
            }
            dbData[colName] = parsed;
        }));

        let user = { 
            id: 'anon', 
            username: 'Guest', 
            avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' 
        };
        
        try {
            // Try to get current user from context or Reddit API
            if (context.userId) {
                user = { 
                    id: context.userId, 
                    username: context.username || 'RedditUser',
                    avatar_url: user.avatar_url // Default
                };
            }
            
            // Always try to fetch rich profile for snoovatar (Server Source of Truth)
            const currUser = await reddit.getCurrentUser();
            if (currUser) {
                const snoovatarUrl = await currUser.getSnoovatarUrl();
                user = {
                    id: currUser.id,
                    username: currUser.username,
                    // Use Snoovatar if available, else fallback to standard Reddit static default
                    avatar_url: snoovatarUrl ?? 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
            }
        } catch(e) { 
            console.warn('User fetch failed', e); 
        }

        // Hydrate User Total (for immediate UI availability)
        if (user && user.id !== 'anon') {
             let total = await redis.get(\`user_total:\${user.id}\`);
             if (!total) {
                 total = await recalculateUserTotal(user.id);
             }
             user.total_tipped = parseInt(total || '0') || 0;
        }

        return { dbData, user };
    } catch(e) {
        console.error('Hydration Error:', e);
        return { dbData: {}, user: null };
    }
}

// --- API Routes (Client -> Server) ---
// Note: All client-callable endpoints must start with /api/

router.get('/api/init', async (_req, res) => {
    const data = await fetchAllData();
    res.json(data);
});

// Polyfill Endpoint: Get Project/Context Info
router.get('/api/project', async (_req, res) => {
    try {
        const { postId, subredditName, userId } = context;
        // Map Devvit Context to WebSim Project Structure
        res.json({
            id: postId || 'local-dev',
            title: subredditName ? \`r/\${subredditName}\` : 'Devvit Project',
            current_version: '1',
            owner: { 
                id: subredditName || 'community',
                username: subredditName || 'community' 
            },
            context: { postId, subredditName, userId }
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/user', async (_req, res) => {
    const { user } = await fetchAllData();
    res.json(user);
});

router.get('/api/identity', async (_req, res) => {
    const { user } = await fetchAllData();
    res.json(user);
});

router.post('/api/save', async (req, res) => {
    try {
        const { collection, key, value } = req.body;
        if (!collection || !key) return res.status(400).json({ error: 'Missing collection or key' });

        // Ensure value is safe to stringify (undefined -> null)
        const safeValue = value === undefined ? null : value;

        await redis.hSet(collection, { [key]: JSON.stringify(safeValue) });
        await redis.zAdd(DB_REGISTRY_KEY, { member: collection, score: Date.now() });
        res.json({ success: true, collection, key });
    } catch(e) {
        console.error('DB Save Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/load', async (req, res) => {
    try {
        const { collection, key } = req.body;
        const value = await redis.hGet(collection, key);
        res.json({ collection, key, value: value ? JSON.parse(value) : null });
    } catch(e) {
        console.error('DB Get Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/delete', async (req, res) => {
    try {
        const { collection, key } = req.body;
        if (!collection || !key) return res.status(400).json({ error: 'Missing collection or key' });

        await redis.hDel(collection, [key]);
        res.json({ success: true, collection, key });
    } catch(e) {
        console.error('DB Delete Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Tip & Supporter Endpoints (WebSim Porting) ---

router.get('/api/tips', async (req, res) => {
  try {
    const userId = req.query.userId;
    const postId = context.postId;
    
    // 1. Redis Source (Primary for Consistency)
    // We prioritize our internal index because it's updated immediately upon fulfillment,
    // whereas payments.getOrders() can have eventual consistency lag.
    let orderIds = [];
    try {
      const rawIds = await redis.zRange(\`post_orders:\${postId}\`, 0, -1) || [];
      orderIds = rawIds.map(x => typeof x === 'string' ? x : x.member);
    } catch (e) {
      console.warn("Redis fetch failed:", e);
    }

    // 2. Payments API Fallback (Recovery)
    // If Redis is empty, try the official API just in case we missed a webhook
    if (orderIds.length === 0) {
        try {
            const { orders } = await payments.getOrders({ postId: postId, limit: 100 });
            orderIds = (orders || [])
                .filter(o => o.status === 'PAID')
                .map(o => o.id);
        } catch(e) { console.warn("Payments API fallback failed:", e); }
    }
    
    if (orderIds.length === 0) {
        return res.json({ comments: { data: [], meta: { has_next_page: false } } });
    }

    // 3. Fetch Full Order Details from Redis
    // We store rich metadata in 'order:{id}' during fulfillment
    const orderPromises = orderIds.map(id => redis.get(\`order:\${id}\`));
    const orderStrings = await Promise.all(orderPromises);
    const orders = orderStrings
      .filter(s => s !== null)
      .map(s => JSON.parse(s));
    
    // 4. Filter by User (if requested)
    const filtered = userId 
      ? orders.filter(o => o.userId === userId)
      : orders;
    
    // 5. Transform to WebSim Comment Format
    const mapped = await Promise.all(filtered.map(async (o) => {
      // Try to get associated comment metadata (text, avatar, username)
      // This key is set in POST /api/comments if available, or inferred
      const commentMeta = await redis.hGetAll(\`tip_comment:\${o.id}\`) || {};
      
      const username = commentMeta.username || 'Supporter';
      const avatarUrl = commentMeta.avatar || \`/_websim_avatar_/\${o.userId}\`; // Uses client-side injector
      
      // Ensure numeric amount
      const amount = typeof o.amount === 'number' ? o.amount : parseInt(o.amount || '0');

      return {
        comment: {
          id: o.id,
          project_id: 'local',
          raw_content: commentMeta.text || \`Tipped \${amount} Gold\`,
          content: { type: 'doc', content: [] },
          created_at: o.createdAt || new Date().toISOString(),
          author: {
            id: o.userId,
            username: username,
            avatar_url: avatarUrl
          },
          card_data: {
            type: 'tip_comment',
            credits_spent: amount
          }
        }
      };
    }));
    
    // Sort by most recent (assuming orderIds came in order, but safety sort)
    mapped.sort((a, b) => new Date(b.comment.created_at) - new Date(a.comment.created_at));

    res.json({
      comments: {
        data: mapped,
        meta: { has_next_page: false }
      }
    });
  } catch (e) {
    console.error("GET /api/tips failed:", e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/user-total/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    let total = await redis.get(\`user_total:\${userId}\`);
    
    // Self-healing: If 0 or missing, try to recalculate from history
    if (!total || total === '0') {
        const recalc = await recalculateUserTotal(userId);
        total = String(recalc);
    }
    
    res.json({ total: parseInt(total || '0') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/supporters', async (req, res) => {
  try {
    const postId = context.postId;
    
    // 1. Get all Order IDs for this Post
    // Using zRange on the sorted set we maintain in /internal/payments/fulfill
    const rawIds = await redis.zRange(\`post_orders:\${postId}\`, 0, -1) || [];
    const orderIds = rawIds.map(x => typeof x === 'string' ? x : x.member);
    
    // 2. Fetch Order Details
    const orderPromises = orderIds.map(id => redis.get(\`order:\${id}\`));
    const orderStrings = await Promise.all(orderPromises);
    const orders = orderStrings
      .filter(s => s !== null)
      .map(s => JSON.parse(s));
    
    // 3. Aggregate Tips by User
    const userMap = new Map();
    const userInfo = new Map(); // Store latest username/avatar info found in orders

    for (const o of orders) {
      const current = userMap.get(o.userId) || 0;
      userMap.set(o.userId, current + o.amount);
      
      // Try to capture user info if available in order (optional enhancement)
      // Otherwise client will lookup via /api/lookup/avatar
    }
    
    // 4. Format for WebSim
    const supporters = Array.from(userMap.entries())
      .map(([uid, amt]) => ({
        userId: uid,
        totalTips: amt,
        // Helper fields for client
        username: 'Supporter', 
        avatarUrl: \`/_websim_avatar_/\${uid}\`
      }))\
      .sort((a, b) => b.totalTips - a.totalTips);
    
    res.json({ supporters });
  } catch (e) {
    console.error("GET /api/supporters failed:", e);
    res.status(500).json({ error: e.message });
  }
});

// --- Realtime Relay (Client -> Server -> Clients) ---
// --- Payments Endpoints (Fulfillment) ---
router.post('/internal/payments/fulfill', async (req, res) => {
  try {
    const order = req.body.order || req.body;
    
    if (!order || order.status !== 'PAID') {
      return res.json({ success: false, reason: 'Order not paid or invalid' });
    }
    
    const product = order.products && order.products[0];
    const sku = product ? product.sku : '';
    const match = sku.match(/(\\d+)/); 
    const amount = match ? parseInt(match[1]) : 0;
    
    if (amount === 0) {
      return res.json({ success: false, reason: 'Invalid SKU' });
    }
    
    // 1. Identify User & Post (Context Recovery)
    let userId = order.userId || order.user?.id || order.author?.id || order.customerId || req.body.userId || context.userId;
    const orderId = order.id;
    let postId = order.postId || order.post?.id || context.postId;
    
    // Recovery Phase 1: Try to recover userId from pending tips if missing
    if (!userId && amount > 0) {
        try {
            const pattern = \`pending_tip:*:\${amount}\`;
            const keys = await redis.keys(pattern);
            if (keys && keys.length > 0) {
                const recoveredKey = keys[0]; // e.g., pending_tip:t2_xyz:5
                const parts = recoveredKey.split(':');
                if (parts.length >= 3) userId = parts[1];
            }
        } catch(e) {}
    }

    if (!userId) {
      console.error(\`[Fulfill] User ID missing for Order \${orderId}\`);
      return res.json({ success: false, reason: 'Missing userId' });
    }
    
    // Recovery Phase 2: Check for Pending Tip Metadata EARLY to recover postId
    // We need the postId *before* we index the order in 'post_orders'
    let pendingCommentData = null;
    let pendingKey = \`pending_tip:\${userId}:\${amount}\`;
    
    try {
        const rawPending = await redis.get(pendingKey);
        if (rawPending) {
            pendingCommentData = JSON.parse(rawPending);
            // RECOVER POST ID
            if (!postId && pendingCommentData.postId) {
                postId = pendingCommentData.postId;
                console.log(\`[Fulfill] Recovered postId \${postId} from pending tip\`);
            }
        }
    } catch(e) { console.warn("[Fulfill] Pending read error", e); }

    console.log(\`[Fulfill] Order \${orderId} | User \${userId} | Amount \${amount} | Post \${postId}\`);

    // 2. Idempotency Check & Totals
    const existingOrder = await redis.get(\`order:\${orderId}\`);
    if (!existingOrder) {
        const totalKey = \`user_total:\${userId}\`;
        const currentTotal = await redis.get(totalKey) || '0';
        await redis.set(totalKey, String(parseInt(currentTotal) + amount));
        
        if (postId) {
          await redis.incrBy(\`tips:\${postId}:\${userId}\`, amount);
        }
    }

    // 3. Save Order Record (with potentially recovered postId)
    await redis.set(\`order:\${orderId}\`, JSON.stringify({
      id: orderId,
      userId: userId,
      postId: postId,
      amount: amount,
      sku: sku,
      createdAt: order.createdAt || new Date().toISOString(),
      status: 'PAID'
    }));
    
    // 4. Index Order (History & Post Lists)
    // NOW safe to index because we've done our best to recover postId
    await redis.zAdd(\`user_orders:\${userId}\`, { member: orderId, score: Date.now() });
    
    if (postId) {
      await redis.zAdd(\`post_orders:\${postId}\`, { member: orderId, score: Date.now() });
    }
    
    // 5. Link/Cleanup Pending Metadata
    if (pendingCommentData) {
      try {
        console.log(\`[Fulfill] Linking Pending Comment \${pendingCommentData.commentId} to Order \${orderId}\`);
        
        const metadata = {
          text: pendingCommentData.text || '',
          credits: String(amount),
          username: pendingCommentData.username || 'Supporter',
          avatar: pendingCommentData.avatar || '',
          type: 'tip_comment',
          credits_spent: String(amount)
        };
        
        // Store keyed by Order ID (for /api/tips)
        await redis.hSet(\`tip_comment:\${orderId}\`, metadata);
        
        // Store keyed by Comment ID (for /api/comments)
        if (pendingCommentData.commentId) {
            await redis.hSet(\`tip_comment:\${pendingCommentData.commentId}\`, metadata);
        }
        
        // Cleanup
        await redis.del(pendingKey);
      } catch(e) {}
    }
    
    return res.json({ success: true });
  } catch (e) {
    console.error('Payment Fulfillment Error:', e);
    res.status(500).json({ success: false, reason: e.message });
  }
});

router.post('/internal/payments/refund', async (req, res) => {
    res.json({ success: true });
});

router.post('/api/realtime/message', async (req, res) => {
    try {
        const msg = req.body;
        // console.log('[Server] Relaying Realtime Message:', JSON.stringify(msg).substring(0, 200));
        
        // Broadcast to 'global_room' which clients subscribe to via connectRealtime
        await realtime.send('global_room', msg);
        res.json({ success: true });
    } catch(e) {
        console.error('[Server] Realtime Relay Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Comment API (WebSim Polyfill) ---
router.get('/api/comments', async (req, res) => {
    try {
        const postId = context.postId;
        if (!postId) return res.json({ comments: { data: [], meta: {} } });

        const onlyTips = req.query.only_tips === 'true';

        // Get comments from Reddit
        let comments = [];
        try {
            // reddit.getComments returns a Promise<Listing<Comment>>
            const listing = await reddit.getComments({
                postId: postId,
                limit: onlyTips ? 100 : 50
            });
            // Convert listing to array safely if it's iterable
            comments = listing || [];
            if (listing && typeof listing.all === 'function') {
                 // Some versions of Devvit client expose .all()
                 comments = await listing.all();
            }
        } catch (e) {
            console.warn('Reddit API getComments failed:', e);
            comments = [];
        }

        // Transform to WebSim format
        let data = await Promise.all(comments.map(async (c) => {
            // Check for tip metadata (Standardized on tip_comment: prefix)
            const metaKey = \`tip_comment:\${c.id}\`;
            const meta = await redis.hGetAll(metaKey);
            const isTip = meta && (meta.type === 'tip_comment' || parseInt(meta.credits || '0') > 0);
            
            // Filter early if we only want tips
            if (onlyTips && !isTip) return null;

            return {
                comment: {
                    id: c.id,
                    project_id: 'local',
                    raw_content: c.body,
                    content: { type: 'doc', content: [] }, // simplified structure
                    author: {
                        id: c.authorId,
                        username: c.authorName,
                        avatar_url: '/_websim_avatar_/' + c.authorName
                    },
                    reply_count: 0, 
                    created_at: c.createdAt.toISOString(),
                    parent_comment_id: c.parentId.startsWith('t1_') ? c.parentId : null,
                    card_data: isTip ? {
                        type: 'tip_comment',
                        credits_spent: parseInt(meta.credits_spent || meta.credits || '0')\n                    } : null
                }
            };
        }));

        // Remove filtered items
        data = data.filter(item => item !== null);

        res.json({
            comments: {
                data: data,
                meta: { has_next_page: false, end_cursor: null }
            }
        });

    } catch (e) {
        console.error('Fetch Comments Endpoint Error:', e);
        // Return valid empty response on error to prevent client "Failed to fetch" crashes
        res.json({ comments: { data: [], meta: {} } });
    }
});

router.post('/api/comments', async (req, res) => {
  try {
    const { content, parentId, credits } = req.body;
    const postId = context.postId;
    
    const text = content || '';
    const targetId = parentId || postId;
    
    if (!targetId) return res.status(400).json({ error: 'No target ID (Post Context missing)' });

    // Submit comment to Reddit
    const result = await reddit.submitComment({
      id: targetId,
      text: text || ' ', // Reddit requires non-empty body
      runAs: 'USER'
    });
    
    // If this comment is a TIP, create a "Pending Link" for the fulfillment handler to find
    if (credits && parseInt(credits) > 0) {
      const user = await reddit.getCurrentUser();
      const userId = user?.id || context.userId;
      const amount = parseInt(credits);
      
      // Key: pending_tip:{userId}:{amount}
      // This bridges the gap between the Comment (ID known now) and the Order (ID known later via webhook)
      const pendingKey = \`pending_tip:\${userId}:\${amount}\`;
      
      await redis.set(pendingKey, JSON.stringify({
        commentId: result.id,
        postId: postId,
        text: text,
        username: user?.username || 'User',
        avatar: user?.profileImage || '',
        timestamp: Date.now()
      }), { 
        ex: 300 // Expire after 5 minutes
      });
      
      console.log(\`[Comment] Pending Tip Link: \${pendingKey} (User: \${userId}, Amount: \${amount}) -> Comment: \${result.id}\`);
      
      // Also store by comment ID immediately, just in case
      await redis.hSet(\`tip_comment:\${result.id}\`, {
        text: text,
        credits: String(credits),
        username: user?.username || 'User',
        avatar: user?.profileImage || '' 
      });
    }
    
    res.json({ success: true, id: result.id });
  } catch (e) {
    console.error('Post Comment Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// --- Avatar Lookup Route (Client Injection) ---
// --- Avatar Fallback (Prevents 404s) ---
router.get('/_websim_avatar_/:username', async (req, res) => {
    // Redirect to proxy which handles the lookup
    res.redirect('/api/proxy/avatar/' + req.params.username);
});

router.get('/api/lookup/avatar/:username', async (req, res) => {
    const { username } = req.params;
    const defaultAvatar = 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png';
    
    if (username === 'guest' || username === 'null' || !username) {
        return res.json({ url: defaultAvatar });
    }

    try {
        const user = await reddit.getUserByUsername(username);
        let url = null;
        if (user) {
            url = await user.getSnoovatarUrl();
        }
        res.json({ url: url || defaultAvatar });
    } catch (e) {
        console.warn('Avatar lookup failed for', username, e.message);
        res.json({ url: defaultAvatar });
    }
});

// --- WebSim Search Proxies ---
router.get('/api/v1/search/assets', async (req, res) => {
    try {
        const query = new URLSearchParams(req.query).toString();
        const response = await fetch(\`https://websim.ai/api/v1/search/assets?\${query}\`);
        if (!response.ok) return res.status(response.status).json({ error: 'Upstream Error' });
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error('Search Proxy Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/v1/search/assets/relevant', async (req, res) => {
    try {
        const query = new URLSearchParams(req.query).toString();
        const response = await fetch(\`https://websim.ai/api/v1/search/assets/relevant?\${query}\`);
        if (!response.ok) return res.status(response.status).json({ error: 'Upstream Error' });
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error('Search Proxy Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Avatar Proxy Route (Legacy/Fallback) ---
router.get('/api/proxy/avatar/:username', async (req, res) => {
    const { username } = req.params;
    try {
        // Attempt to get the latest Snoovatar from Reddit
        const user = await reddit.getUserByUsername(username);
        let url = null;
        if (user) {
            url = await user.getSnoovatarUrl();
        }
        res.redirect(url || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png');
    } catch (e) {
        // Fallback silently if user not found or API error
        res.redirect('https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png');
    }
});

// --- JSON "File" Upload Routes (Redis-backed) ---
router.post('/api/json/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const data = req.body;
        // Persist JSON to Redis
        await redis.set('json:' + key, JSON.stringify(data));
        res.json({ ok: true, url: '/api/json/' + key });
    } catch(e) {
        console.error('JSON Upload Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/json/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const data = await redis.get('json:' + key);
        if (!data) return res.status(404).json({ error: 'Not found' });
        
        // Return as proper JSON
        res.header('Content-Type', 'application/json');
        res.send(data);
    } catch(e) {
        console.error('JSON Load Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Internal Routes (Menu/Triggers) ---
// Note: All internal endpoints must start with /internal/

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

app.use(router);

const port = getServerPort();
const server = createServer(app);

server.on('error', (err) => console.error(\`server error; \${err.stack}\`));
server.listen(port, () => console.log(\`Server listening on \${port}\`));
`;
};

