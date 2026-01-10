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
            // Matches: /api/v1/projects/{UUID}/comments... (Capture query params)
            const commentMatch = input.match(/\\/api\\/v1\\/projects\\/[^/]+\\/comments(.*)/);
            if (commentMatch) {
                const query = commentMatch[1] || '';
                // console.log("[Polyfill] Intercepting Comment Fetch:", input, "->", '/api/comments' + query);
                return originalFetch('/api/comments' + query, init);
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
                return { id: 'local', title: 'Reddit Game', current_version: '1', owner: { username: 'unknown' } };
            },
            getCurrentProject: async () => {
                return window.websim.getProject();
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

                return new Promise((resolve) => {
                    // UI Injection for Comment/Tip Modal
                    const modal = document.createElement('div');
                    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI\",Roboto,sans-serif;color:white;';
                    
                    const isTip = data.credits && data.credits > 0;
                    const prefilled = data.content || '';
                    
                    let innerHtml = '';
                    
                    // Logic to map WebSim Credits to Reddit Gold SKUs
                    let goldSku = 'tip_5_gold';
                    let goldPrice = 5;
                    let goldUsd = '$0.10';

                    if (isTip) {
                        const c = data.credits;
                        if (c >= 750) { goldSku = 'tip_100_gold'; goldPrice = 100; goldUsd = '$2.00'; }
                        else if (c >= 400) { goldSku = 'tip_50_gold'; goldPrice = 50; goldUsd = '$1.00'; }
                        else if (c >= 200) { goldSku = 'tip_25_gold'; goldPrice = 25; goldUsd = '$0.50'; }
                        
                        innerHtml = \`
                            <div style="background:#1A1A1B;padding:0;border-radius:16px;width:90%;max-width:360px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.5);border:1px solid #343536;">
                                <div style="padding:24px;text-align:center;">
                                    <div style="width:64px;height:64px;background:#FFd700;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:32px;color:#8B7500;box-shadow:inset 0 -4px 0 rgba(0,0,0,0.2);">
                                        🪙
                                    </div>
                                    <h3 style="margin:0 0 8px 0;font-size:1.25rem;">Support the Creator</h3>
                                    <p style="color:#D7DADC;margin:0 0 24px 0;font-size:0.9rem;line-height:1.4;">
                                        This action requires a tip. Swap your <strong>\${c} Credits</strong> for:
                                    </p>
                                    
                                    <div style="background:#272729;border:1px solid #343536;border-radius:12px;padding:16px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;">
                                        <div style="text-align:left;">
                                            <div style="font-weight:700;font-size:1.1rem;color:#FFd700;">\${goldPrice} Gold</div>
                                            <div style="font-size:0.8rem;color:#818384;">Approx. \${goldUsd}</div>
                                        </div>
                                        <div style=\"font-size:1.5rem;\">➔</div>
                                    </div>
                                    
                                    <button id="ws-modal-pay" style="background:#D93A00;color:white;border:none;padding:12px 24px;border-radius:99px;font-weight:700;font-size:1rem;cursor:pointer;width:100%;transition:transform 0.1s;">
                                        Purchase \${goldPrice} Gold
                                    </button>
                                    <button id="ws-modal-close" style="background:transparent;color:#818384;border:none;padding:12px;margin-top:8px;font-weight:600;cursor:pointer;width:100%;">
                                        Cancel
                                    </button>
                                </div>
                                <div style="background:#272729;padding:12px;font-size:0.75rem;color:#818384;text-align:center;border-top:1px solid #343536;">
                                    Secured by Reddit Payments
                                </div>
                            </div>
                        \`;
                    } else {
                        // Standard Comment UI
                        innerHtml = \`
                            <div style="background:#1A1A1B;padding:24px;border-radius:12px;width:90%;max-width:500px;display:flex;flex-direction:column;gap:16px;border:1px solid #343536;">
                                <h3 style="margin:0;color:#D7DADC;">💬 Post a Comment</h3>
                                <textarea id="ws-comment-input" style="width:100%;height:100px;background:#272729;border:1px solid #343536;border-radius:8px;color:white;padding:12px;font-family:inherit;font-size:1rem;resize:none;box-sizing:border-box;">\${prefilled}</textarea>
                                <div style="display:flex;gap:10px;justify-content:flex-end;">
                                    <button id="ws-modal-cancel" style="background:transparent;color:#818384;border:none;padding:10px 16px;cursor:pointer;font-weight:600;">Cancel</button>
                                    <button id="ws-modal-post" style="background:#D7DADC;color:#1A1A1B;border:none;padding:10px 24px;border-radius:99px;font-weight:bold;cursor:pointer;">Post Comment</button>
                                </div>
                            </div>
                        \`;
                    }
                    
                    modal.innerHTML = innerHtml;
                    document.body.appendChild(modal);
                    
                    const close = () => { document.body.removeChild(modal); };

                    if (isTip) {
                        modal.querySelector('#ws-modal-close').onclick = () => {
                            close();
                            resolve({ error: 'User cancelled' });
                        };
                        
                        modal.querySelector('#ws-modal-pay').onclick = async () => {
                            const btn = modal.querySelector('#ws-modal-pay');
                            btn.innerHTML = '<span style=\"display:inline-block;animation:spin 1s linear infinite;\">↻</span> Processing...';
                            btn.disabled = true;
                            
                            // SIMULATION DELAY
                            await new Promise(r => setTimeout(r, 800));

                            // Note: In a pure WebView without a Block wrapper, we cannot trigger 'payments.purchase' directly.
                            // We rely on the user using the native UI in production, but for the game loop to continue,
                            // we simulate a success here and inform the user.
                            
                            alert(`[Devvit Preview] In a real app, this would open the Gold payment sheet for SKU: \${goldSku}.\\n\\nFor this preview, we will simulate a successful transaction so you can see the game reaction!`);
                            
                            close();
                            resolve({}); 
                            // In a real implementation with a wrapper, you would use:
                            // window.parent.postMessage({ type: 'trigger_payment', sku: goldSku }, '*');
                        };
                    } else {
                        const input = modal.querySelector('#ws-comment-input');
                        input.focus();
                        
                        modal.querySelector('#ws-modal-cancel').onclick = () => {
                            close();
                            resolve({ error: 'User cancelled' });
                        };
                        
                        modal.querySelector('#ws-modal-post').onclick = async () => {
                            const text = input.value;
                            if (!text.trim()) return;
                            
                            const btn = modal.querySelector('#ws-modal-post');
                            btn.textContent = 'Posting...';
                            btn.disabled = true;
                            
                            try {
                                const res = await originalFetch('/api/comments', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        content: text,
                                        parentId: data.parent_comment_id
                                    })
                                });
                                
                                if (!res.ok) {
                                    const errData = await res.json().catch(() => ({}));
                                    throw new Error(errData.error || 'Server Error ' + res.status);
                                }

                                const json = await res.json();
                                
                                // Emit local event
                                const user = await window.websim.getCurrentUser();
                                const evt = {
                                    comment: {
                                        id: json.id || 'temp_' + Date.now(),
                                        raw_content: text,
                                        author: user,
                                        created_at: new Date().toISOString(),
                                        parent_comment_id: data.parent_comment_id
                                    }
                                };
                                
                                const listeners = window._websim_comment_listeners || [];
                                listeners.forEach(cb => cb(evt));
                                
                                close();
                                resolve({});
                            } catch(e) {
                                console.error("Comment Post Failed:", e);
                                alert("Failed to post comment: " + e.message);
                                btn.textContent = 'Retry';
                                btn.disabled = false;
                            }
                        };
                    }
                });
            },
            addEventListener: (event, cb) => {
                if (event === 'comment:created') {
                     if (!window._websim_comment_listeners) window._websim_comment_listeners = [];
                     window._websim_comment_listeners.push(cb);
                }
            },

            collection: (name) => {
                // Return safe stubs to prevent crashes before hydration
                // If WebsimSocket exists (realtime.js), use it. Otherwise use generic DB stub.
                if (window.websimSocketInstance && typeof window.websimSocketInstance.collection === 'function') {
                    return window.websimSocketInstance.collection(name);
                }
                // Fallback / Pre-init stub
                return {
                    subscribe: (cb) => { if(cb) cb([]); return () => {}; }, 
                    getList: () => [], 
                    create: async () => ({}), 
                    update: async () => ({}), 
                    delete: async () => {}, 
                    filter: () => ({ subscribe: (cb) => { if(cb) cb([]); return () => {}; }, getList: () => [] })
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