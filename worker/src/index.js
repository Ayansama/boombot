export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const { pathname } = url;
        const startTime = Date.now();

        // CORS headers: needed so browser can call the Worker
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        };

        // Handle preflight
        if (request.method === "OPTIONS") {
            console.log(`[API] 204 Preflight OPTIONS ${pathname}`);
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // POST /calls: save a call
            if (pathname === "/calls" && request.method === "POST") {
                const body = await request.json();
                const { call_id, start_time, end_time, duration, transcript, metrics } = body;

                console.log(`[API] POST /calls - Storing call ${call_id} (duration: ${duration}s)`);

                // Insert into calls table
                await env.DB.prepare(
                    `INSERT INTO calls (id, start_time, end_time, duration) VALUES (?, ?, ?, ?)`
                ).bind(call_id, start_time, end_time, duration).run();

                // Insert transcript turns
                if (transcript && transcript.length > 0) {
                    for (const turn of transcript) {
                        await env.DB.prepare(
                            `INSERT INTO transcripts (call_id, role, content, timestamp) VALUES (?, ?, ?, ?)`
                        ).bind(call_id, turn.role, turn.content, turn.timestamp).run();
                    }
                }

                // Insert metrics
                if (metrics && metrics.length > 0) {
                    for (const m of metrics) {
                        await env.DB.prepare(
                            `INSERT INTO call_metrics (call_id, turn_index, stt_latency, llm_latency, tts_latency)
               VALUES (?, ?, ?, ?, ?)`
                        ).bind(call_id, m.turn_index, m.stt_latency, m.llm_latency, m.tts_latency).run();
                    }
                }

                const elapsed = Date.now() - startTime;
                console.log(`[API] 201 Created - Call ${call_id} saved (${transcript?.length || 0} turns, ${metrics?.length || 0} metrics, ${elapsed}ms)`);
                return Response.json({ success: true, call_id }, { status: 201, headers: corsHeaders });
            }

            // GET /calls: list all calls
            if (pathname === "/calls" && request.method === "GET") {
                const { results } = await env.DB.prepare(
                    `SELECT id, start_time, end_time, duration, created_at FROM calls ORDER BY created_at DESC`
                ).all();

                const elapsed = Date.now() - startTime;
                console.log(`[API] 200 OK - GET /calls returned ${results.length} calls (${elapsed}ms)`);
                return Response.json(results, { headers: corsHeaders });
            }

            // GET /calls/:id: call detail
            const match = pathname.match(/^\/calls\/(.+)$/);
            if (match && request.method === "GET") {
                const id = match[1];

                const call = await env.DB.prepare(
                    `SELECT * FROM calls WHERE id = ?`
                ).bind(id).first();

                if (!call) {
                    console.warn(`[API] 404 Not Found - Call ${id} does not exist`);
                    return Response.json({ error: "Call not found" }, { status: 404, headers: corsHeaders });
                }

                const { results: transcript } = await env.DB.prepare(
                    `SELECT role, content, timestamp FROM transcripts WHERE call_id = ? ORDER BY timestamp ASC`
                ).bind(id).all();

                const { results: metrics } = await env.DB.prepare(
                    `SELECT turn_index, stt_latency, llm_latency, tts_latency FROM call_metrics WHERE call_id = ?`
                ).bind(id).all();

                const elapsed = Date.now() - startTime;
                console.log(`[API] 200 OK - GET /calls/${id} (${transcript.length} turns, ${metrics.length} metrics, ${elapsed}ms)`);
                return Response.json({ ...call, transcript, metrics }, { headers: corsHeaders });
            }

            console.warn(`[API] 404 Not Found - Route ${request.method} ${pathname}`);
            return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });

        } catch (err) {
            console.error(`[API Error] ${request.method} ${pathname}:`, err);
            return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
        }
    }
};