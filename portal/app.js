/* ============================================
   CustomerMaxing Portal - Application Logic
   ============================================ */

(function () {
    'use strict';

    // ── Configuration ────────────────────────
    const SUPABASE_URL = 'https://vzvqpanrxemediggvtaf.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6dnFwYW5yeGVtZWRpZ2d2dGFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIzNDcyNDksImV4cCI6MjA4NzkyMzI0OX0.BSgaoiXopChkpVCZvCud7iEtc7yx7yZYrcw7NlusuR0';

    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Derive client slug from subdomain
    const hostname = window.location.hostname;
    const clientSlug = hostname.includes('.') ? hostname.split('.')[0] : 'demo';

    // ── State ────────────────────────────────
    let currentUser = null;
    let currentClient = null;
    let currentView = 'dashboard';
    let callsPage = 1;
    const CALLS_PER_PAGE = 20;
    let realtimeSubscription = null;

    // ── DOM References ───────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const loginScreen = $('#login-screen');
    const accessDeniedScreen = $('#access-denied-screen');
    const appShell = $('#app');

    // ── Initialization ───────────────────────
    async function init() {
        // Check existing session
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            await handleAuthenticatedUser(session.user);
        } else {
            showLogin();
        }

        // Auth state listener
        supabase.auth.onAuthStateChange(async (event, session) => {
            if (event === 'SIGNED_IN' && session) {
                await handleAuthenticatedUser(session.user);
            } else if (event === 'SIGNED_OUT') {
                cleanup();
                showLogin();
            }
        });

        bindGlobalEvents();
    }

    // ── Auth ─────────────────────────────────
    function showLogin() {
        loginScreen.classList.remove('hidden');
        accessDeniedScreen.classList.add('hidden');
        appShell.classList.add('hidden');
    }

    function showAccessDenied() {
        loginScreen.classList.add('hidden');
        accessDeniedScreen.classList.remove('hidden');
        appShell.classList.add('hidden');
    }

    function showApp() {
        loginScreen.classList.add('hidden');
        accessDeniedScreen.classList.add('hidden');
        appShell.classList.remove('hidden');
    }

    async function handleAuthenticatedUser(user) {
        // Verify user belongs to this client
        const { data: cmUser, error } = await supabase
            .from('cm_users')
            .select('*, cm_clients(*)')
            .eq('user_id', user.id)
            .eq('client_slug', clientSlug)
            .single();

        if (error || !cmUser) {
            showAccessDenied();
            return;
        }

        currentUser = { ...user, ...cmUser };
        currentClient = cmUser.cm_clients || { name: clientSlug, slug: clientSlug };

        showApp();
        renderUserInfo();
        navigateTo(window.location.hash.replace('#', '') || 'dashboard');
        setupRealtime();
    }

    async function login(email, password) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return data;
    }

    async function logout() {
        cleanup();
        await supabase.auth.signOut();
    }

    function cleanup() {
        if (realtimeSubscription) {
            supabase.removeChannel(realtimeSubscription);
            realtimeSubscription = null;
        }
        currentUser = null;
        currentClient = null;
    }

    // ── Realtime ─────────────────────────────
    function setupRealtime() {
        realtimeSubscription = supabase
            .channel('cm_calls_realtime')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'cm_calls',
                filter: `client_slug=eq.${clientSlug}`
            }, (payload) => {
                // Refresh dashboard stats and recent calls on any call change
                if (currentView === 'dashboard') {
                    loadDashboardData();
                }
                if (currentView === 'calls') {
                    loadCallLog();
                }
                showToast('New call activity detected', 'info');
            })
            .subscribe();
    }

    // ── Navigation / Routing ─────────────────
    function navigateTo(view) {
        const validViews = ['dashboard', 'calls', 'knowledge', 'team', 'settings'];
        if (!validViews.includes(view)) view = 'dashboard';

        currentView = view;
        window.location.hash = view;

        // Update nav
        $$('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view);
        });

        // Show view
        $$('.view').forEach(v => v.classList.remove('active'));
        const viewEl = $(`#view-${view}`);
        if (viewEl) viewEl.classList.add('active');

        // Close mobile sidebar
        closeSidebar();

        // Load data for view
        switch (view) {
            case 'dashboard': loadDashboardData(); break;
            case 'calls': loadCallLog(); break;
            case 'knowledge': loadKnowledgeBase(); break;
            case 'team': loadTeamMembers(); break;
            case 'settings': loadSettings(); break;
        }
    }

    // ── Global Events ────────────────────────
    function bindGlobalEvents() {
        // Login form
        $('#login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = $('#login-btn');
            const error = $('#login-error');
            const email = $('#login-email').value.trim();
            const password = $('#login-password').value;

            btn.disabled = true;
            btn.querySelector('.btn-text').textContent = 'Signing in...';
            btn.querySelector('.btn-spinner').classList.remove('hidden');
            error.classList.add('hidden');

            try {
                await login(email, password);
            } catch (err) {
                error.textContent = err.message || 'Invalid email or password';
                error.classList.remove('hidden');
            } finally {
                btn.disabled = false;
                btn.querySelector('.btn-text').textContent = 'Sign In';
                btn.querySelector('.btn-spinner').classList.add('hidden');
            }
        });

        // Logout buttons
        $('#logout-btn').addEventListener('click', logout);
        $('#logout-denied-btn').addEventListener('click', logout);

        // Sidebar nav
        $$('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                navigateTo(item.dataset.view);
            });
        });

        // Mobile sidebar
        $('#sidebar-toggle').addEventListener('click', toggleSidebar);
        $('#sidebar-overlay').addEventListener('click', closeSidebar);

        // Hash change
        window.addEventListener('hashchange', () => {
            const hash = window.location.hash.replace('#', '');
            if (hash && hash !== currentView) navigateTo(hash);
        });

        // Call log filters
        $('#call-filter-btn').addEventListener('click', () => { callsPage = 1; loadCallLog(); });
        $('#call-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { callsPage = 1; loadCallLog(); } });

        // Transcript modal
        $('#transcript-close').addEventListener('click', closeTranscriptModal);
        $('#transcript-modal .modal-backdrop').addEventListener('click', closeTranscriptModal);

        // Knowledge base
        $('#kb-add-btn').addEventListener('click', () => openKBModal());
        $('#kb-modal-close').addEventListener('click', closeKBModal);
        $('#kb-modal .modal-backdrop').addEventListener('click', closeKBModal);
        $('#kb-cancel-btn').addEventListener('click', closeKBModal);
        $('#kb-form').addEventListener('submit', saveKBEntry);
        $('#kb-search').addEventListener('input', debounce(loadKnowledgeBase, 300));
        $('#kb-category-filter').addEventListener('change', loadKnowledgeBase);

        // Team members
        $('#team-add-btn').addEventListener('click', () => openTeamModal());
        $('#team-modal-close').addEventListener('click', closeTeamModal);
        $('#team-modal .modal-backdrop').addEventListener('click', closeTeamModal);
        $('#team-cancel-btn').addEventListener('click', closeTeamModal);
        $('#team-form').addEventListener('submit', saveTeamMember);

        // Settings
        $('#settings-form').addEventListener('submit', saveSettings);

        // View all calls link
        $('a.link-btn[href="#calls"]').addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo('calls');
        });
    }

    // ── Sidebar (mobile) ─────────────────────
    function toggleSidebar() {
        $('#sidebar').classList.toggle('open');
        $('#sidebar-overlay').classList.toggle('open');
    }
    function closeSidebar() {
        $('#sidebar').classList.remove('open');
        $('#sidebar-overlay').classList.remove('open');
    }

    // ── User Info Rendering ──────────────────
    function renderUserInfo() {
        if (!currentUser) return;
        const initials = getInitials(currentUser.email);
        const name = currentUser.full_name || currentUser.email.split('@')[0];

        $('#sidebar-user-name').textContent = name;
        $('#sidebar-user-email').textContent = currentUser.email;
        $('#sidebar-avatar').textContent = initials;
        $('#mobile-avatar').textContent = initials;
        $('#sidebar-org-name').textContent = currentClient?.name || clientSlug;
    }

    // ── Dashboard ────────────────────────────
    async function loadDashboardData() {
        await Promise.all([
            loadDashboardStats(),
            loadCallsChart(),
            loadRecentCalls()
        ]);
    }

    async function loadDashboardStats() {
        const today = new Date().toISOString().split('T')[0];

        // Total calls today
        const { count: totalCalls } = await supabase
            .from('cm_calls')
            .select('*', { count: 'exact', head: true })
            .eq('client_slug', clientSlug)
            .gte('created_at', today + 'T00:00:00')
            .lt('created_at', today + 'T23:59:59');

        // AI-handled calls today
        const { count: aiCalls } = await supabase
            .from('cm_calls')
            .select('*', { count: 'exact', head: true })
            .eq('client_slug', clientSlug)
            .eq('handled_by', 'ai')
            .gte('created_at', today + 'T00:00:00')
            .lt('created_at', today + 'T23:59:59');

        // Average response time (seconds)
        const { data: avgData } = await supabase
            .from('cm_calls')
            .select('response_time_seconds')
            .eq('client_slug', clientSlug)
            .gte('created_at', today + 'T00:00:00')
            .not('response_time_seconds', 'is', null);

        let avgTime = '--';
        if (avgData && avgData.length > 0) {
            const sum = avgData.reduce((a, b) => a + (b.response_time_seconds || 0), 0);
            const avg = Math.round(sum / avgData.length);
            avgTime = avg + 's';
        }

        // Satisfaction score (average)
        const { data: satData } = await supabase
            .from('cm_calls')
            .select('satisfaction_score')
            .eq('client_slug', clientSlug)
            .gte('created_at', today + 'T00:00:00')
            .not('satisfaction_score', 'is', null);

        let satisfaction = '--';
        if (satData && satData.length > 0) {
            const sum = satData.reduce((a, b) => a + (b.satisfaction_score || 0), 0);
            satisfaction = (sum / satData.length).toFixed(1) + '/5';
        }

        $('#stat-total-calls').textContent = totalCalls ?? 0;
        $('#stat-ai-calls').textContent = aiCalls ?? 0;
        $('#stat-avg-time').textContent = avgTime;
        $('#stat-satisfaction').textContent = satisfaction;
    }

    async function loadCallsChart() {
        const chartEl = $('#calls-chart');
        const days = [];
        const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        // Get last 7 days
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            days.push({
                date: d.toISOString().split('T')[0],
                label: dayLabels[d.getDay()],
                count: 0
            });
        }

        // Fetch call counts for the week
        const weekStart = days[0].date + 'T00:00:00';
        const { data: calls } = await supabase
            .from('cm_calls')
            .select('created_at')
            .eq('client_slug', clientSlug)
            .gte('created_at', weekStart);

        if (calls) {
            calls.forEach(call => {
                const callDate = call.created_at.split('T')[0];
                const day = days.find(d => d.date === callDate);
                if (day) day.count++;
            });
        }

        const maxCount = Math.max(...days.map(d => d.count), 1);

        chartEl.innerHTML = days.map(day => {
            const heightPct = (day.count / maxCount) * 100;
            return `
                <div class="bar-group">
                    <div class="bar-wrapper">
                        <div class="bar" style="height: ${Math.max(heightPct, 3)}%">
                            <span class="bar-value">${day.count}</span>
                        </div>
                    </div>
                    <span class="bar-label">${day.label}</span>
                </div>
            `;
        }).join('');
    }

    async function loadRecentCalls() {
        const { data: calls, error } = await supabase
            .from('cm_calls')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('created_at', { ascending: false })
            .limit(10);

        const tbody = $('#recent-calls-body');

        if (error || !calls || calls.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No calls yet. Calls will appear here once your AI agent starts handling them.</td></tr>';
            return;
        }

        tbody.innerHTML = calls.map(call => `
            <tr class="clickable" data-call-id="${call.id}">
                <td>${formatTime(call.created_at)}</td>
                <td>${escapeHtml(call.caller_name || call.caller_number || 'Unknown')}</td>
                <td>${formatDuration(call.duration_seconds)}</td>
                <td>${renderHandlerBadge(call.handled_by)}</td>
                <td>${renderStatusBadge(call.status)}</td>
            </tr>
        `).join('');

        // Click to show transcript
        tbody.querySelectorAll('tr.clickable').forEach(row => {
            row.addEventListener('click', () => showCallDetails(row.dataset.callId));
        });
    }

    // ── Call Log ──────────────────────────────
    async function loadCallLog() {
        const search = $('#call-search').value.trim();
        const dateFrom = $('#call-date-from').value;
        const dateTo = $('#call-date-to').value;
        const handler = $('#call-handler-filter').value;
        const status = $('#call-status-filter').value;

        let query = supabase
            .from('cm_calls')
            .select('*', { count: 'exact' })
            .eq('client_slug', clientSlug)
            .order('created_at', { ascending: false })
            .range((callsPage - 1) * CALLS_PER_PAGE, callsPage * CALLS_PER_PAGE - 1);

        if (search) {
            query = query.or(`caller_name.ilike.%${search}%,caller_number.ilike.%${search}%`);
        }
        if (dateFrom) query = query.gte('created_at', dateFrom + 'T00:00:00');
        if (dateTo) query = query.lte('created_at', dateTo + 'T23:59:59');
        if (handler) query = query.eq('handled_by', handler);
        if (status) query = query.eq('status', status);

        const { data: calls, count, error } = await query;

        const tbody = $('#calls-table-body');

        if (error || !calls || calls.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="table-empty">No calls found matching your filters.</td></tr>';
            renderPagination(0);
            return;
        }

        tbody.innerHTML = calls.map(call => `
            <tr class="clickable" data-call-id="${call.id}">
                <td>${formatDateTime(call.created_at)}</td>
                <td>${escapeHtml(call.caller_name || call.caller_number || 'Unknown')}</td>
                <td>${formatDuration(call.duration_seconds)}</td>
                <td>${renderHandlerBadge(call.handled_by)}</td>
                <td>${renderStatusBadge(call.status)}</td>
                <td>${call.recording_url ? `<a href="${escapeHtml(call.recording_url)}" target="_blank" class="link-btn" onclick="event.stopPropagation()">Play</a>` : '<span class="text-muted">--</span>'}</td>
            </tr>
        `).join('');

        tbody.querySelectorAll('tr.clickable').forEach(row => {
            row.addEventListener('click', () => showCallDetails(row.dataset.callId));
        });

        renderPagination(count || 0);
    }

    function renderPagination(total) {
        const pag = $('#calls-pagination');
        const totalPages = Math.ceil(total / CALLS_PER_PAGE);
        if (totalPages <= 1) { pag.innerHTML = ''; return; }

        let html = '';
        html += `<button class="page-btn" ${callsPage <= 1 ? 'disabled' : ''} data-page="${callsPage - 1}">&lt;</button>`;

        const start = Math.max(1, callsPage - 2);
        const end = Math.min(totalPages, callsPage + 2);
        for (let i = start; i <= end; i++) {
            html += `<button class="page-btn ${i === callsPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
        }

        html += `<button class="page-btn" ${callsPage >= totalPages ? 'disabled' : ''} data-page="${callsPage + 1}">&gt;</button>`;
        pag.innerHTML = html;

        pag.querySelectorAll('.page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (page >= 1 && page <= totalPages) {
                    callsPage = page;
                    loadCallLog();
                }
            });
        });
    }

    async function showCallDetails(callId) {
        const { data: call, error } = await supabase
            .from('cm_calls')
            .select('*')
            .eq('id', callId)
            .single();

        if (error || !call) {
            showToast('Could not load call details', 'error');
            return;
        }

        $('#detail-caller').textContent = call.caller_name || call.caller_number || 'Unknown';
        $('#detail-datetime').textContent = formatDateTime(call.created_at);
        $('#detail-duration').textContent = formatDuration(call.duration_seconds);
        $('#detail-handler').textContent = call.handled_by === 'ai' ? 'AI Agent' : call.handled_by || 'Unknown';
        $('#detail-status').innerHTML = renderStatusBadge(call.status);
        $('#detail-sentiment').textContent = call.sentiment || '--';

        // Render transcript
        const transcriptEl = $('#transcript-body');
        if (call.transcript && Array.isArray(call.transcript)) {
            transcriptEl.innerHTML = call.transcript.map(line => `
                <div class="transcript-line">
                    <span class="transcript-speaker ${line.role === 'caller' ? 'caller' : ''}">${escapeHtml(line.role === 'caller' ? 'Caller' : 'AI Agent')}:</span>
                    ${escapeHtml(line.text)}
                </div>
            `).join('');
        } else if (call.transcript && typeof call.transcript === 'string') {
            transcriptEl.innerHTML = `<p>${escapeHtml(call.transcript)}</p>`;
        } else {
            transcriptEl.innerHTML = '<p class="text-muted">No transcript available for this call.</p>';
        }

        $('#transcript-modal').classList.remove('hidden');
    }

    function closeTranscriptModal() {
        $('#transcript-modal').classList.add('hidden');
    }

    // ── Knowledge Base ───────────────────────
    async function loadKnowledgeBase() {
        const search = $('#kb-search').value.trim();
        const category = $('#kb-category-filter').value;

        let query = supabase
            .from('cm_knowledge_base')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('updated_at', { ascending: false });

        if (search) query = query.ilike('title', `%${search}%`);
        if (category) query = query.eq('category', category);

        const { data: entries, error } = await query;

        const grid = $('#kb-grid');

        if (error || !entries || entries.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1/-1; text-align:center; padding:3rem; color: var(--gray-400);">
                    ${error ? 'Error loading knowledge base.' : 'No entries yet. Click "Add Entry" to create your first knowledge base article.'}
                </div>`;
            return;
        }

        grid.innerHTML = entries.map(entry => `
            <div class="kb-card" data-id="${entry.id}">
                <div class="kb-card-header">
                    <span class="kb-card-title">${escapeHtml(entry.title)}</span>
                    <span class="badge ${categoryBadgeClass(entry.category)} kb-card-category">${escapeHtml(entry.category)}</span>
                </div>
                <div class="kb-card-content">${escapeHtml(entry.content || '')}</div>
                <div class="kb-card-actions">
                    <button class="btn btn-sm btn-secondary kb-edit-btn" data-id="${entry.id}">Edit</button>
                    <button class="btn btn-sm btn-ghost kb-delete-btn" data-id="${entry.id}" style="color:var(--red-500);">Delete</button>
                </div>
            </div>
        `).join('');

        // Bind edit/delete
        grid.querySelectorAll('.kb-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => editKBEntry(btn.dataset.id));
        });
        grid.querySelectorAll('.kb-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteKBEntry(btn.dataset.id));
        });
    }

    function openKBModal(entry = null) {
        $('#kb-modal-title').textContent = entry ? 'Edit Knowledge Base Entry' : 'Add Knowledge Base Entry';
        $('#kb-edit-id').value = entry ? entry.id : '';
        $('#kb-title').value = entry ? entry.title : '';
        $('#kb-category').value = entry ? entry.category : 'FAQ';
        $('#kb-content').value = entry ? entry.content : '';
        $('#kb-modal').classList.remove('hidden');
    }

    function closeKBModal() {
        $('#kb-modal').classList.add('hidden');
        $('#kb-form').reset();
    }

    async function editKBEntry(id) {
        const { data: entry, error } = await supabase
            .from('cm_knowledge_base')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !entry) {
            showToast('Could not load entry', 'error');
            return;
        }
        openKBModal(entry);
    }

    async function saveKBEntry(e) {
        e.preventDefault();
        const id = $('#kb-edit-id').value;
        const payload = {
            client_slug: clientSlug,
            title: $('#kb-title').value.trim(),
            category: $('#kb-category').value,
            content: $('#kb-content').value.trim(),
            updated_at: new Date().toISOString()
        };

        let error;
        if (id) {
            ({ error } = await supabase.from('cm_knowledge_base').update(payload).eq('id', id));
        } else {
            payload.created_at = new Date().toISOString();
            ({ error } = await supabase.from('cm_knowledge_base').insert(payload));
        }

        if (error) {
            showToast('Failed to save entry: ' + error.message, 'error');
            return;
        }

        showToast(id ? 'Entry updated' : 'Entry created', 'success');
        closeKBModal();
        loadKnowledgeBase();
    }

    async function deleteKBEntry(id) {
        if (!confirm('Are you sure you want to delete this knowledge base entry?')) return;

        const { error } = await supabase.from('cm_knowledge_base').delete().eq('id', id);
        if (error) {
            showToast('Failed to delete entry: ' + error.message, 'error');
            return;
        }
        showToast('Entry deleted', 'success');
        loadKnowledgeBase();
    }

    // ── Team Members ─────────────────────────
    async function loadTeamMembers() {
        const { data: members, error } = await supabase
            .from('cm_team_members')
            .select('*')
            .eq('client_slug', clientSlug)
            .order('routing_order', { ascending: true });

        const grid = $('#team-grid');

        if (error || !members || members.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1/-1; text-align:center; padding:3rem; color: var(--gray-400);">
                    ${error ? 'Error loading team members.' : 'No team members yet. Click "Add Member" to add your first team member.'}
                </div>`;
            return;
        }

        grid.innerHTML = members.map(member => `
            <div class="team-card" data-id="${member.id}">
                <div class="team-avatar ${member.is_available ? '' : 'offline'}">${getInitials(member.name)}</div>
                <div class="team-info">
                    <div class="team-name">${escapeHtml(member.name)}</div>
                    <div class="team-role">${escapeHtml(member.role || 'Team Member')}</div>
                    <div class="team-meta">
                        <span class="team-phone">${escapeHtml(member.phone)}</span>
                        <span class="badge ${member.is_available ? 'badge-green' : 'badge-gray'}">${member.is_available ? 'Available' : 'Offline'}</span>
                        <span class="badge badge-blue">Order: ${member.routing_order || '--'}</span>
                    </div>
                </div>
                <div class="team-actions">
                    <label class="toggle" title="Toggle availability">
                        <input type="checkbox" ${member.is_available ? 'checked' : ''} data-member-id="${member.id}" class="team-toggle-avail">
                        <span class="toggle-slider"></span>
                    </label>
                    <div style="display:flex;gap:0.25rem;">
                        <button class="btn-icon team-edit-btn" data-id="${member.id}" title="Edit">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="btn-icon team-delete-btn" data-id="${member.id}" title="Remove" style="color:var(--red-500);">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');

        // Bind events
        grid.querySelectorAll('.team-toggle-avail').forEach(toggle => {
            toggle.addEventListener('change', async () => {
                const memberId = toggle.dataset.memberId;
                const { error } = await supabase
                    .from('cm_team_members')
                    .update({ is_available: toggle.checked })
                    .eq('id', memberId);

                if (error) {
                    showToast('Failed to update availability', 'error');
                    toggle.checked = !toggle.checked;
                } else {
                    loadTeamMembers();
                }
            });
        });

        grid.querySelectorAll('.team-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => editTeamMember(btn.dataset.id));
        });
        grid.querySelectorAll('.team-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteTeamMember(btn.dataset.id));
        });
    }

    function openTeamModal(member = null) {
        $('#team-modal-title').textContent = member ? 'Edit Team Member' : 'Add Team Member';
        $('#team-edit-id').value = member ? member.id : '';
        $('#team-name').value = member ? member.name : '';
        $('#team-phone').value = member ? member.phone : '';
        $('#team-role').value = member ? (member.role || '') : '';
        $('#team-routing-order').value = member ? member.routing_order : '';
        $('#team-modal').classList.remove('hidden');
    }

    function closeTeamModal() {
        $('#team-modal').classList.add('hidden');
        $('#team-form').reset();
    }

    async function editTeamMember(id) {
        const { data: member, error } = await supabase
            .from('cm_team_members')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !member) {
            showToast('Could not load member', 'error');
            return;
        }
        openTeamModal(member);
    }

    async function saveTeamMember(e) {
        e.preventDefault();
        const id = $('#team-edit-id').value;
        const payload = {
            client_slug: clientSlug,
            name: $('#team-name').value.trim(),
            phone: $('#team-phone').value.trim(),
            role: $('#team-role').value.trim() || null,
            routing_order: parseInt($('#team-routing-order').value) || 1
        };

        let error;
        if (id) {
            ({ error } = await supabase.from('cm_team_members').update(payload).eq('id', id));
        } else {
            payload.is_available = true;
            payload.created_at = new Date().toISOString();
            ({ error } = await supabase.from('cm_team_members').insert(payload));
        }

        if (error) {
            showToast('Failed to save member: ' + error.message, 'error');
            return;
        }

        showToast(id ? 'Member updated' : 'Member added', 'success');
        closeTeamModal();
        loadTeamMembers();
    }

    async function deleteTeamMember(id) {
        if (!confirm('Are you sure you want to remove this team member?')) return;

        const { error } = await supabase.from('cm_team_members').delete().eq('id', id);
        if (error) {
            showToast('Failed to remove member: ' + error.message, 'error');
            return;
        }
        showToast('Member removed', 'success');
        loadTeamMembers();
    }

    // ── Settings ─────────────────────────────
    async function loadSettings() {
        const { data: settings, error } = await supabase
            .from('cm_settings')
            .select('*')
            .eq('client_slug', clientSlug)
            .single();

        if (error || !settings) return;

        $('#setting-company-name').value = settings.company_name || '';
        $('#setting-business-hours-open').value = settings.business_hours_open || '09:00';
        $('#setting-business-hours-close').value = settings.business_hours_close || '17:00';
        $('#setting-twilio-number').value = settings.twilio_number || '';
        $('#setting-greeting').value = settings.greeting_message || '';
        $('#setting-tone').value = settings.ai_tone || 'professional';
        $('#setting-max-hold').value = settings.max_hold_time || 30;
        $('#setting-escalation').value = settings.escalation_rule || 'always_try_ai';
        $('#setting-notify-missed').checked = settings.notify_missed_calls !== false;
        $('#setting-notify-escalation').checked = settings.notify_escalations !== false;
        $('#setting-notify-daily').checked = settings.notify_daily_summary === true;
    }

    async function saveSettings(e) {
        e.preventDefault();

        const payload = {
            client_slug: clientSlug,
            company_name: $('#setting-company-name').value.trim(),
            business_hours_open: $('#setting-business-hours-open').value,
            business_hours_close: $('#setting-business-hours-close').value,
            greeting_message: $('#setting-greeting').value.trim(),
            ai_tone: $('#setting-tone').value,
            max_hold_time: parseInt($('#setting-max-hold').value) || 30,
            escalation_rule: $('#setting-escalation').value,
            notify_missed_calls: $('#setting-notify-missed').checked,
            notify_escalations: $('#setting-notify-escalation').checked,
            notify_daily_summary: $('#setting-notify-daily').checked,
            updated_at: new Date().toISOString()
        };

        // Upsert settings
        const { error } = await supabase
            .from('cm_settings')
            .upsert(payload, { onConflict: 'client_slug' });

        if (error) {
            showToast('Failed to save settings: ' + error.message, 'error');
            return;
        }
        showToast('Settings saved successfully', 'success');
    }

    // ── Helpers ──────────────────────────────
    function getInitials(name) {
        if (!name) return '?';
        const parts = name.split(/[\s@]+/);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return name.substring(0, 2).toUpperCase();
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatTime(isoStr) {
        if (!isoStr) return '--';
        const d = new Date(isoStr);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatDateTime(isoStr) {
        if (!isoStr) return '--';
        const d = new Date(isoStr);
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) +
            ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatDuration(seconds) {
        if (!seconds && seconds !== 0) return '--';
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function renderHandlerBadge(handler) {
        if (handler === 'ai') return '<span class="badge badge-purple">AI Agent</span>';
        if (handler === 'human') return '<span class="badge badge-blue">Team Member</span>';
        return '<span class="badge badge-gray">' + escapeHtml(handler || 'Unknown') + '</span>';
    }

    function renderStatusBadge(status) {
        const map = {
            completed: 'badge-green',
            missed: 'badge-red',
            voicemail: 'badge-yellow',
            transferred: 'badge-blue',
            in_progress: 'badge-purple'
        };
        const cls = map[status] || 'badge-gray';
        const label = status ? status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ') : 'Unknown';
        return `<span class="badge ${cls}">${label}</span>`;
    }

    function categoryBadgeClass(category) {
        const map = {
            'FAQ': 'badge-blue',
            'Policies': 'badge-purple',
            'Procedures': 'badge-yellow',
            'Contact Info': 'badge-green',
            'Custom': 'badge-gray'
        };
        return map[category] || 'badge-gray';
    }

    function showToast(message, type = 'info') {
        const container = $('#toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    function debounce(fn, ms) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), ms);
        };
    }

    // ── Boot ─────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);
})();
