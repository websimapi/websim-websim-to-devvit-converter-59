export const websimStubsJs = `
// [WebSim] API Stubs - Global Script
(function() {
    // Shared state via window._currentUser (managed by socket.js/DevvitBridge)
    const getSharedUser = () => window._currentUser;

    // --- 1. Monkeypatch Fetch for Comments API ---
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
        let url = input;
        if (typeof input === 'string') {
            // Intercept WebSim Comment API calls
            // Matches: /api/v1/projects/{UUID}/comments...
            if (input.match(/\\/api\\/v1\\/projects\\/[^/]+\\/comments/)) {
                // console.log("[Polyfill] Intercepting Comment Fetch:", input);
                return originalFetch('/api/comments', init);
            }
        }
        return originalFetch(input, init);
    };

    if (!window.websim) {
        window.websim = {
            getCurrentUser: async () => {
                // Wait for handshake (up to 3s)
                let tries = 0;
                while(!getSharedUser() && tries < 30) {
                    await new Promise(r => setTimeout(r, 100));
                    tries++;
                }
                
                const u = getSharedUser() || {
                    id: 'guest', username: 'Guest', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
                
                // Polyfill camelCase for consistency (Game ports often expect avatarUrl)
                if (u.avatar_url && !u.avatarUrl) u.avatarUrl = u.avatar_url;
                
                return u;
            },
            getProject: async () => {
                try {
                    const res = await fetch('/api/project');
                    if (res.ok) return await res.json();
                } catch(e) { console.warn("[Polyfill] getProject failed:", e); }
                return { id: 'local', title: 'Reddit Game', owner: { username: 'unknown' } };
            },
            getCreator: async () => {
                try {
                    const res = await fetch('/api/project');
                    if (res.ok) {
                        const data = await res.json();
                        return data.owner;
                    }
                } catch(e) { console.warn("[Polyfill] getCreator failed:", e); }
                return { id: 'owner', username: 'GameOwner' };
            },
            
            // --- Commenting & Tipping Polyfill ---
            postComment: async (data) => {
                // Data: { content: string, parent_comment_id?: string, credits?: number }
                console.log("[Polyfill] postComment:", data);
                
                // Handle Tips
                if (data.credits && data.credits > 0) {
                    // In Devvit WebView, we cannot easily trigger the native payment sheet 
                    // without postMessage to a Blocks wrapper. 
                    // For now, we show a toast instructing the user (or log error).
                    // This is a limitation of the WebView porting model without a Blocks UI companion.
                    console.warn("[Polyfill] Native tipping requires Devvit Blocks. Please implement UI trigger.");
                    
                    // Attempt to inform user if toast available
                    alert(\`Please use the Reddit 'Tip' button above the post to send \${data.credits} Gold! (WebView integration pending)\`);
                    return { error: "Tipping requires native UI interaction." };
                }

                // Handle Text Comments
                if (data.content) {
                    try {
                        const res = await originalFetch('/api/comments', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                content: data.content,
                                parentId: data.parent_comment_id
                            })
                        });
                        const json = await res.json();
                        
                        // Emit local event so UI updates instantly
                        const user = await window.websim.getCurrentUser();
                        const evt = {
                            comment: {
                                id: json.id || 'temp_' + Date.now(),
                                raw_content: data.content,
                                author: user,
                                created_at: new Date().toISOString(),
                                parent_comment_id: data.parent_comment_id
                            }
                        };
                        
                        // Fake event dispatch
                        const listeners = window._websim_comment_listeners || [];
                        listeners.forEach(cb => cb(evt));
                        
                        return {}; // Success
                    } catch(e) {
                        console.error("Comment Post Failed:", e);
                        return { error: e.message };
                    }
                }
                return {};
            },
            addEventListener: (event, cb) => {
                if (event === 'comment:created') {
                     if (!window._websim_comment_listeners) window._websim_comment_listeners = [];
                     window._websim_comment_listeners.push(cb);
                }
            },

            collection: (name) => {
                // Return safe stubs to prevent crashes before hydration
                return window.websimSocketInstance ? window.websimSocketInstance.collection(name) : {
                    subscribe: () => {}, 
                    getList: () => [], 
                    create: async () => {}, 
                    update: async () => {}, 
                    delete: async () => {}, 
                    filter: () => ({ subscribe: () => {}, getList: () => [] })
                };
            },
            search: {
                assets: async (opts) => {
                    const params = new URLSearchParams();
                    if (opts.q) params.set('q', opts.q);
                    if (opts.mime_type_prefix) params.set('mime_type_prefix', opts.mime_type_prefix);
                    if (opts.limit) params.set('limit', opts.limit);
                    return fetch('/api/v1/search/assets?' + params.toString()).then(r => r.json());
                },
                relevant: async (opts) => {
                    const params = new URLSearchParams();
                    if (opts.q) params.set('q', opts.q);
                    if (opts.limit) params.set('limit', opts.limit);
                    return fetch('/api/v1/search/assets/relevant?' + params.toString()).then(r => r.json());
                }
            },
            upload: async (file) => {
                // Smart Upload: JSON persistence via Redis, Media via BlobURL (session)
                try {
                    let isJson = file.type === 'application/json' || (file.name && file.name.endsWith('.json'));
                    
                    if (!isJson && (!file.type || file.type === 'text/plain')) {
                        try {
                            // Quick sniff for JSON content
                            const text = await file.text();
                            const trimmed = text.trim();
                            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                                JSON.parse(trimmed);
                                isJson = true;
                            }
                        } catch(e) {}
                    }

                    if (isJson) {
                        const text = await file.text();
                        const data = JSON.parse(text);
                        // Generate ID
                        const key = 'up_' + Math.random().toString(36).substr(2, 9);
                        
                        // Upload to our custom JSON route
                        await fetch('/api/json/' + key, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data)
                        });
                        
                        return '/api/json/' + key;
                    }
                    
                    // Fallback to Blob URL for images/audio (Session only)
                    return URL.createObjectURL(file);
                } catch(e) { 
                    console.error("Upload failed", e);
                    return ''; 
                }
            }
        };
    }
})();
`;