/**
 * FeedPulse - Feedback Aggregation Tool
 * A Cloudflare Workers application for collecting and analyzing customer feedback
 */

// =============================================================================
// TYPES
// =============================================================================

interface FeedbackInput {
	source: 'twitter' | 'discord' | 'github' | 'support';
	content: string;
}

interface FeedbackAnalysis {
	sentiment: 'positive' | 'negative' | 'neutral';
	category: 'bug' | 'feature' | 'praise' | 'complaint';
	priority: number;
	themes: string[];
}

interface Feedback extends FeedbackInput, FeedbackAnalysis {
	id: number;
	created_at: string;
}

interface InsightsResponse {
	total: number;
	sentiment: {
		positive: number;
		negative: number;
		neutral: number;
	};
	categories: Record<string, number>;
	topThemes: { theme: string; count: number }[];
	highPriority: Feedback[];
}

// =============================================================================
// AI ANALYSIS
// =============================================================================

/**
 * Uses Workers AI to analyze feedback content
 * Extracts sentiment, category, priority, and themes
 */
async function analyzeFeedback(ai: Ai, content: string): Promise<FeedbackAnalysis> {
	const prompt = `You are a feedback analyzer. Analyze the following customer feedback and respond with ONLY a valid JSON object, no other text.

Feedback: "${content}"

Analyze and respond with this exact JSON structure:
{
  "sentiment": "<positive|negative|neutral>",
  "category": "<bug|feature|praise|complaint>",
  "priority": <1-5 where 5 is most urgent>,
  "themes": ["<theme1>", "<theme2>"]
}

Rules:
- sentiment: positive (happy, satisfied, thankful), negative (frustrated, angry, disappointed), neutral (informational, questions)
- category: bug (something broken), feature (request for new functionality), praise (compliment), complaint (dissatisfaction)
- priority: 5 = critical/urgent, 4 = high, 3 = medium, 2 = low, 1 = minimal
- themes: 1-3 short keywords describing the main topics (e.g., "performance", "ui", "pricing", "documentation")

Respond with ONLY the JSON object.`;

	try {
		const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
			prompt,
			max_tokens: 200,
		});

		// Extract JSON from response
		const text = (response as { response: string }).response;
		const jsonMatch = text.match(/\{[\s\S]*\}/);

		if (!jsonMatch) {
			throw new Error('No JSON found in AI response');
		}

		const analysis = JSON.parse(jsonMatch[0]) as FeedbackAnalysis;

		// Validate and sanitize the response
		return {
			sentiment: ['positive', 'negative', 'neutral'].includes(analysis.sentiment)
				? analysis.sentiment
				: 'neutral',
			category: ['bug', 'feature', 'praise', 'complaint'].includes(analysis.category)
				? analysis.category
				: 'complaint',
			priority: Math.min(5, Math.max(1, Math.round(analysis.priority) || 3)),
			themes: Array.isArray(analysis.themes)
				? analysis.themes.slice(0, 5).map((t) => String(t).toLowerCase().trim())
				: [],
		};
	} catch (error) {
		console.error('AI analysis failed:', error);
		// Return safe defaults if AI fails
		return {
			sentiment: 'neutral',
			category: 'complaint',
			priority: 3,
			themes: [],
		};
	}
}

// =============================================================================
// API HANDLERS
// =============================================================================

/**
 * POST /api/feedback
 * Adds new feedback, analyzes it with AI, and stores in D1
 */
async function handlePostFeedback(request: Request, env: Env): Promise<Response> {
	try {
		const body = (await request.json()) as FeedbackInput;

		// Validate input
		if (!body.content || typeof body.content !== 'string') {
			return Response.json({ error: 'content is required' }, { status: 400 });
		}

		const validSources = ['twitter', 'discord', 'github', 'support'];
		if (!body.source || !validSources.includes(body.source)) {
			return Response.json(
				{ error: `source must be one of: ${validSources.join(', ')}` },
				{ status: 400 }
			);
		}

		// Analyze with AI
		const analysis = await analyzeFeedback(env.AI, body.content);

		// Store in D1
		const result = await env.DB.prepare(
			`INSERT INTO feedback (source, content, sentiment, category, priority, themes)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
		)
			.bind(
				body.source,
				body.content,
				analysis.sentiment,
				analysis.category,
				analysis.priority,
				JSON.stringify(analysis.themes)
			)
			.first<Feedback>();

		// Parse themes back to array for response
		if (result) {
			result.themes = JSON.parse(result.themes as unknown as string);
		}

		return Response.json({ success: true, feedback: result }, { status: 201 });
	} catch (error) {
		console.error('Error creating feedback:', error);
		return Response.json({ error: 'Failed to create feedback' }, { status: 500 });
	}
}

/**
 * GET /api/feedback
 * Returns feedback with optional filters and pagination
 * Query params: source, sentiment, category, priority, dateRange, page (default 1), limit (default 10)
 */
async function handleGetFeedback(request: Request, env: Env): Promise<Response> {
	try {
		const url = new URL(request.url);
		const source = url.searchParams.get('source');
		const sentiment = url.searchParams.get('sentiment');
		const category = url.searchParams.get('category');
		const priority = url.searchParams.get('priority');
		const dateRange = url.searchParams.get('dateRange');
		const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
		const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '10')));
		const offset = (page - 1) * limit;

		// Build WHERE clause for both queries
		let whereClause = ' WHERE 1=1';
		const params: (string | number)[] = [];

		if (source) {
			whereClause += ' AND source = ?';
			params.push(source);
		}
		if (sentiment) {
			whereClause += ' AND sentiment = ?';
			params.push(sentiment);
		}
		if (category) {
			whereClause += ' AND category = ?';
			params.push(category);
		}
		if (priority) {
			whereClause += ' AND priority = ?';
			params.push(parseInt(priority));
		}
		// Date range filter
		if (dateRange) {
			const now = new Date();
			let dateThreshold: Date | null = null;

			switch (dateRange) {
				case '24h':
					dateThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
					break;
				case '7d':
					dateThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
					break;
				case '30d':
					dateThreshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
					break;
			}

			if (dateThreshold) {
				whereClause += ' AND created_at >= ?';
				params.push(dateThreshold.toISOString());
			}
		}

		// Get total count for pagination
		const countQuery = 'SELECT COUNT(*) as total FROM feedback' + whereClause;
		const countStmt = env.DB.prepare(countQuery);
		const countResult = await (params.length > 0 ? countStmt.bind(...params) : countStmt).first<{
			total: number;
		}>();
		const total = countResult?.total || 0;

		// Get paginated results
		const dataQuery = 'SELECT * FROM feedback' + whereClause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
		const dataParams = [...params, limit, offset];
		const dataStmt = env.DB.prepare(dataQuery);
		const result = await dataStmt.bind(...dataParams).all<Feedback>();

		// Parse themes JSON for each result
		const feedback = result.results.map((f) => ({
			...f,
			themes: typeof f.themes === 'string' ? JSON.parse(f.themes) : f.themes,
		}));

		const totalPages = Math.ceil(total / limit);

		return Response.json({
			success: true,
			feedback,
			pagination: {
				page,
				limit,
				total,
				totalPages,
				hasNext: page < totalPages,
				hasPrev: page > 1,
			},
		});
	} catch (error) {
		console.error('Error fetching feedback:', error);
		return Response.json({ error: 'Failed to fetch feedback' }, { status: 500 });
	}
}

/**
 * GET /api/insights
 * Returns aggregated analytics and insights
 */
async function handleGetInsights(env: Env): Promise<Response> {
	try {
		// Run all queries in parallel for better performance
		const [totalResult, sentimentResult, categoryResult, allFeedback, highPriorityResult] =
			await Promise.all([
				// Total count
				env.DB.prepare('SELECT COUNT(*) as total FROM feedback').first<{ total: number }>(),

				// Sentiment breakdown
				env.DB.prepare(
					`SELECT sentiment, COUNT(*) as count FROM feedback GROUP BY sentiment`
				).all<{ sentiment: string; count: number }>(),

				// Category breakdown
				env.DB.prepare(
					`SELECT category, COUNT(*) as count FROM feedback GROUP BY category`
				).all<{ category: string; count: number }>(),

				// All feedback for theme extraction
				env.DB.prepare('SELECT themes FROM feedback').all<{ themes: string }>(),

				// High priority items (priority >= 4)
				env.DB.prepare(
					`SELECT * FROM feedback WHERE priority >= 4 ORDER BY priority DESC, created_at DESC LIMIT 5`
				).all<Feedback>(),
			]);

		// Calculate sentiment percentages
		const total = totalResult?.total || 0;
		const sentimentCounts = { positive: 0, negative: 0, neutral: 0 };
		sentimentResult.results.forEach((r) => {
			if (r.sentiment in sentimentCounts) {
				sentimentCounts[r.sentiment as keyof typeof sentimentCounts] = r.count;
			}
		});

		// Calculate category distribution
		const categories: Record<string, number> = {};
		categoryResult.results.forEach((r) => {
			categories[r.category] = r.count;
		});

		// Extract and count themes
		const themeCounts: Record<string, number> = {};
		allFeedback.results.forEach((f) => {
			try {
				const themes = typeof f.themes === 'string' ? JSON.parse(f.themes) : f.themes;
				if (Array.isArray(themes)) {
					themes.forEach((theme: string) => {
						const t = theme.toLowerCase().trim();
						if (t) {
							themeCounts[t] = (themeCounts[t] || 0) + 1;
						}
					});
				}
			} catch {
				// Skip invalid JSON
			}
		});

		// Get top 5 themes
		const topThemes = Object.entries(themeCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([theme, count]) => ({ theme, count }));

		// Parse high priority feedback
		const highPriority = highPriorityResult.results.map((f) => ({
			...f,
			themes: typeof f.themes === 'string' ? JSON.parse(f.themes) : f.themes,
		}));

		const insights: InsightsResponse = {
			total,
			sentiment: sentimentCounts,
			categories,
			topThemes,
			highPriority,
		};

		return Response.json({ success: true, insights });
	} catch (error) {
		console.error('Error fetching insights:', error);
		return Response.json({ error: 'Failed to fetch insights' }, { status: 500 });
	}
}

/**
 * GET /api/themes
 * Returns feedback grouped by themes
 */
async function handleGetThemes(env: Env): Promise<Response> {
	try {
		const result = await env.DB.prepare(
			'SELECT id, content, themes, sentiment, source FROM feedback'
		).all<{ id: number; content: string; themes: string; sentiment: string; source: string }>();

		// Group by themes
		const themeGroups: Record<
			string,
			{ count: number; feedback: { id: number; content: string; sentiment: string; source: string }[] }
		> = {};

		result.results.forEach((f) => {
			try {
				const themes = typeof f.themes === 'string' ? JSON.parse(f.themes) : f.themes;
				if (Array.isArray(themes)) {
					themes.forEach((theme: string) => {
						const t = theme.toLowerCase().trim();
						if (t) {
							if (!themeGroups[t]) {
								themeGroups[t] = { count: 0, feedback: [] };
							}
							themeGroups[t].count++;
							themeGroups[t].feedback.push({
								id: f.id,
								content: f.content,
								sentiment: f.sentiment,
								source: f.source,
							});
						}
					});
				}
			} catch {
				// Skip invalid JSON
			}
		});

		// Sort by count and convert to array
		const themes = Object.entries(themeGroups)
			.sort((a, b) => b[1].count - a[1].count)
			.map(([theme, data]) => ({
				theme,
				count: data.count,
				feedback: data.feedback.slice(0, 3), // Limit to 3 examples per theme
			}));

		return Response.json({ success: true, themes });
	} catch (error) {
		console.error('Error fetching themes:', error);
		return Response.json({ error: 'Failed to fetch themes' }, { status: 500 });
	}
}

/**
 * GET /api/ai-insights
 * Returns AI-powered insights: urgent issues, trending topics, sentiment trends
 */
async function handleGetAIInsights(env: Env): Promise<Response> {
	try {
		// Get all feedback with timestamps for analysis
		const allFeedback = await env.DB.prepare(
			`SELECT id, content, sentiment, category, priority, themes, created_at
       FROM feedback ORDER BY created_at DESC`
		).all<{
			id: number;
			content: string;
			sentiment: string;
			category: string;
			priority: number;
			themes: string;
			created_at: string;
		}>();

		const feedback = allFeedback.results;

		if (feedback.length === 0) {
			return Response.json({
				success: true,
				aiInsights: {
					mostUrgentIssue: null,
					trendingTopic: null,
					sentimentTrend: { trend: 'neutral', description: 'No data yet' },
					themeDistribution: [],
				},
			});
		}

		// 1. Most Urgent Issue: Theme with highest avg priority among negative feedback
		const negativeThemePriorities: Record<string, { total: number; count: number }> = {};
		feedback.forEach((f) => {
			if (f.sentiment === 'negative') {
				try {
					const themes = typeof f.themes === 'string' ? JSON.parse(f.themes) : f.themes;
					if (Array.isArray(themes)) {
						themes.forEach((theme: string) => {
							const t = theme.toLowerCase().trim();
							if (t) {
								if (!negativeThemePriorities[t]) {
									negativeThemePriorities[t] = { total: 0, count: 0 };
								}
								negativeThemePriorities[t].total += f.priority;
								negativeThemePriorities[t].count++;
							}
						});
					}
				} catch {
					// Skip invalid JSON
				}
			}
		});

		let mostUrgentIssue: { theme: string; avgPriority: number; count: number } | null = null;
		let highestAvgPriority = 0;
		Object.entries(negativeThemePriorities).forEach(([theme, data]) => {
			const avg = data.total / data.count;
			if (avg > highestAvgPriority || (avg === highestAvgPriority && data.count > (mostUrgentIssue?.count || 0))) {
				highestAvgPriority = avg;
				mostUrgentIssue = { theme, avgPriority: Math.round(avg * 10) / 10, count: data.count };
			}
		});

		// 2. Trending Topic: Theme that appeared most in recent entries (first 10)
		const recentThemeCounts: Record<string, number> = {};
		const recentFeedback = feedback.slice(0, 10);
		recentFeedback.forEach((f) => {
			try {
				const themes = typeof f.themes === 'string' ? JSON.parse(f.themes) : f.themes;
				if (Array.isArray(themes)) {
					themes.forEach((theme: string) => {
						const t = theme.toLowerCase().trim();
						if (t) {
							recentThemeCounts[t] = (recentThemeCounts[t] || 0) + 1;
						}
					});
				}
			} catch {
				// Skip invalid JSON
			}
		});

		let trendingTopic: { theme: string; count: number; recentMentions: number } | null = null;
		let maxRecentCount = 0;
		Object.entries(recentThemeCounts).forEach(([theme, count]) => {
			if (count > maxRecentCount) {
				maxRecentCount = count;
				trendingTopic = { theme, count, recentMentions: count };
			}
		});

		// 3. Sentiment Trend: Compare recent half vs older half
		const midpoint = Math.floor(feedback.length / 2);
		const recentHalf = feedback.slice(0, midpoint || 1);
		const olderHalf = feedback.slice(midpoint || 1);

		const calcPositiveRatio = (items: typeof feedback) => {
			if (items.length === 0) return 0;
			const positive = items.filter((f) => f.sentiment === 'positive').length;
			const negative = items.filter((f) => f.sentiment === 'negative').length;
			return items.length > 0 ? (positive - negative) / items.length : 0;
		};

		const recentRatio = calcPositiveRatio(recentHalf);
		const olderRatio = calcPositiveRatio(olderHalf);
		const diff = recentRatio - olderRatio;

		let sentimentTrend: { trend: 'improving' | 'declining' | 'stable'; description: string; recentPositive: number; recentNegative: number };
		const recentPositive = recentHalf.filter((f) => f.sentiment === 'positive').length;
		const recentNegative = recentHalf.filter((f) => f.sentiment === 'negative').length;

		if (diff > 0.1) {
			sentimentTrend = {
				trend: 'improving',
				description: 'Sentiment is getting more positive recently',
				recentPositive,
				recentNegative,
			};
		} else if (diff < -0.1) {
			sentimentTrend = {
				trend: 'declining',
				description: 'More negative feedback in recent entries',
				recentPositive,
				recentNegative,
			};
		} else {
			sentimentTrend = {
				trend: 'stable',
				description: 'Sentiment has remained consistent',
				recentPositive,
				recentNegative,
			};
		}

		// 4. Theme Distribution (top 5 with counts and percentages)
		const allThemeCounts: Record<string, number> = {};
		feedback.forEach((f) => {
			try {
				const themes = typeof f.themes === 'string' ? JSON.parse(f.themes) : f.themes;
				if (Array.isArray(themes)) {
					themes.forEach((theme: string) => {
						const t = theme.toLowerCase().trim();
						if (t) {
							allThemeCounts[t] = (allThemeCounts[t] || 0) + 1;
						}
					});
				}
			} catch {
				// Skip invalid JSON
			}
		});

		const totalThemeMentions = Object.values(allThemeCounts).reduce((a, b) => a + b, 0);
		const themeDistribution = Object.entries(allThemeCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([theme, count]) => ({
				theme,
				count,
				percentage: Math.round((count / totalThemeMentions) * 100),
			}));

		return Response.json({
			success: true,
			aiInsights: {
				mostUrgentIssue,
				trendingTopic,
				sentimentTrend,
				themeDistribution,
			},
		});
	} catch (error) {
		console.error('Error fetching AI insights:', error);
		return Response.json({ error: 'Failed to fetch AI insights' }, { status: 500 });
	}
}

/**
 * GET /api/feedback/:id
 * Returns a single feedback item by ID
 */
async function handleGetFeedbackById(id: string, env: Env): Promise<Response> {
	try {
		const result = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?')
			.bind(parseInt(id))
			.first<Feedback & { addressed: number; addressed_at: string | null }>();

		if (!result) {
			return Response.json({ error: 'Feedback not found' }, { status: 404 });
		}

		// Parse themes
		const feedback = {
			...result,
			themes: typeof result.themes === 'string' ? JSON.parse(result.themes) : result.themes,
		};

		return Response.json({ success: true, feedback });
	} catch (error) {
		console.error('Error fetching feedback by ID:', error);
		return Response.json({ error: 'Failed to fetch feedback' }, { status: 500 });
	}
}

/**
 * PATCH /api/feedback/:id
 * Updates a feedback item (currently just marks as addressed)
 */
async function handlePatchFeedback(id: string, request: Request, env: Env): Promise<Response> {
	try {
		const body = (await request.json()) as { addressed?: boolean };

		if (typeof body.addressed === 'boolean') {
			const addressed = body.addressed ? 1 : 0;
			const addressedAt = body.addressed ? new Date().toISOString() : null;

			await env.DB.prepare(
				'UPDATE feedback SET addressed = ?, addressed_at = ? WHERE id = ?'
			)
				.bind(addressed, addressedAt, parseInt(id))
				.run();

			// Fetch updated record
			const result = await env.DB.prepare('SELECT * FROM feedback WHERE id = ?')
				.bind(parseInt(id))
				.first<Feedback & { addressed: number; addressed_at: string | null }>();

			if (!result) {
				return Response.json({ error: 'Feedback not found' }, { status: 404 });
			}

			const feedback = {
				...result,
				themes: typeof result.themes === 'string' ? JSON.parse(result.themes) : result.themes,
			};

			return Response.json({ success: true, feedback });
		}

		return Response.json({ error: 'No valid fields to update' }, { status: 400 });
	} catch (error) {
		console.error('Error updating feedback:', error);
		return Response.json({ error: 'Failed to update feedback' }, { status: 500 });
	}
}

// =============================================================================
// SEED DATA
// =============================================================================

/**
 * POST /api/seed
 * Populates database with realistic mock feedback data
 */
async function handleSeed(env: Env): Promise<Response> {
	// Realistic mock feedback data
	// Distribution: 60% negative, 25% neutral, 15% positive
	// Categories: 40% bugs, 30% features, 20% complaints, 10% praise
	const mockFeedback = [
		// BUGS - Negative (12 items)
		{
			source: 'github',
			content: 'The API keeps timing out when I try to deploy large projects. Getting 504 errors consistently after 30 seconds.',
			sentiment: 'negative',
			category: 'bug',
			priority: 5,
			themes: ['api', 'deployment', 'performance'],
		},
		{
			source: 'discord',
			content: 'Workers AI returns empty responses randomly. About 1 in 10 requests just comes back blank.',
			sentiment: 'negative',
			category: 'bug',
			priority: 5,
			themes: ['workers ai', 'reliability'],
		},
		{
			source: 'support',
			content: 'D1 database queries are failing silently. No error messages, just undefined results.',
			sentiment: 'negative',
			category: 'bug',
			priority: 5,
			themes: ['d1', 'database', 'errors'],
		},
		{
			source: 'github',
			content: 'Wrangler dev mode crashes when using custom domains. Have to restart every few minutes.',
			sentiment: 'negative',
			category: 'bug',
			priority: 4,
			themes: ['wrangler', 'development', 'domains'],
		},
		{
			source: 'twitter',
			content: 'Anyone else seeing their Worker just randomly stop responding? Mine goes down for like 5 mins then comes back.',
			sentiment: 'negative',
			category: 'bug',
			priority: 4,
			themes: ['reliability', 'downtime'],
		},
		{
			source: 'support',
			content: 'KV storage is returning stale data even after writes complete. Cache invalidation seems broken.',
			sentiment: 'negative',
			category: 'bug',
			priority: 4,
			themes: ['kv', 'caching', 'storage'],
		},
		{
			source: 'github',
			content: 'TypeScript types for Env bindings are wrong after running wrangler types. Had to manually fix them.',
			sentiment: 'negative',
			category: 'bug',
			priority: 3,
			themes: ['typescript', 'wrangler', 'dx'],
		},
		{
			source: 'discord',
			content: 'The dashboard keeps logging me out every hour. Super annoying when debugging.',
			sentiment: 'negative',
			category: 'bug',
			priority: 3,
			themes: ['dashboard', 'authentication'],
		},
		{
			source: 'twitter',
			content: 'R2 upload failing for files over 50MB even though docs say 5GB limit. What gives?',
			sentiment: 'negative',
			category: 'bug',
			priority: 4,
			themes: ['r2', 'storage', 'uploads'],
		},
		{
			source: 'github',
			content: 'Cron triggers not firing at the scheduled time. Sometimes 10+ minutes late.',
			sentiment: 'negative',
			category: 'bug',
			priority: 3,
			themes: ['cron', 'scheduling', 'reliability'],
		},
		{
			source: 'support',
			content: 'Pages deployment stuck in "building" state for 2 hours now. Cannot cancel or retry.',
			sentiment: 'negative',
			category: 'bug',
			priority: 4,
			themes: ['pages', 'deployment', 'builds'],
		},
		{
			source: 'discord',
			content: 'Websocket connections dropping after exactly 100 seconds. Thought there was no timeout?',
			sentiment: 'negative',
			category: 'bug',
			priority: 4,
			themes: ['websockets', 'connections', 'reliability'],
		},

		// FEATURE REQUESTS - Neutral (8 items)
		{
			source: 'github',
			content: 'Can you add support for Python 3.12? Would love to use the latest features in Workers.',
			sentiment: 'neutral',
			category: 'feature',
			priority: 3,
			themes: ['python', 'languages', 'workers'],
		},
		{
			source: 'discord',
			content: 'Would be great to have native PostgreSQL support instead of just D1/SQLite.',
			sentiment: 'neutral',
			category: 'feature',
			priority: 3,
			themes: ['database', 'postgresql', 'storage'],
		},
		{
			source: 'twitter',
			content: 'Any plans for a VS Code extension with better Wrangler integration? The current workflow is clunky.',
			sentiment: 'neutral',
			category: 'feature',
			priority: 2,
			themes: ['dx', 'vscode', 'tooling'],
		},
		{
			source: 'github',
			content: 'Please add ability to set memory limits per Worker. Some of mine need more than others.',
			sentiment: 'neutral',
			category: 'feature',
			priority: 3,
			themes: ['workers', 'resources', 'configuration'],
		},
		{
			source: 'support',
			content: 'Is there a way to get detailed cost breakdown per Worker? Hard to optimize without visibility.',
			sentiment: 'neutral',
			category: 'feature',
			priority: 2,
			themes: ['pricing', 'analytics', 'dashboard'],
		},
		{
			source: 'discord',
			content: 'Request: Allow custom error pages for Workers. Want to show branded 500 errors.',
			sentiment: 'neutral',
			category: 'feature',
			priority: 2,
			themes: ['workers', 'errors', 'customization'],
		},
		{
			source: 'github',
			content: 'Would love to see GitHub Actions for D1 migrations. Current manual process is error-prone.',
			sentiment: 'neutral',
			category: 'feature',
			priority: 3,
			themes: ['d1', 'ci/cd', 'automation'],
		},
		{
			source: 'twitter',
			content: 'Any ETA on bringing Queues out of beta? Need it for production but hesitant on beta products.',
			sentiment: 'neutral',
			category: 'feature',
			priority: 3,
			themes: ['queues', 'reliability', 'production'],
		},

		// COMPLAINTS - Negative (6 items)
		{
			source: 'twitter',
			content: 'Why is my bill so high this month?! Jumped from $5 to $47 with no traffic increase. This is ridiculous.',
			sentiment: 'negative',
			category: 'complaint',
			priority: 5,
			themes: ['pricing', 'billing', 'costs'],
		},
		{
			source: 'support',
			content: 'Documentation for Workers AI is so confusing. Spent 3 hours trying to figure out basic setup.',
			sentiment: 'negative',
			category: 'complaint',
			priority: 3,
			themes: ['documentation', 'workers ai', 'onboarding'],
		},
		{
			source: 'discord',
			content: 'The pricing calculator is completely wrong. Estimated $10/month, actually charged $35.',
			sentiment: 'negative',
			category: 'complaint',
			priority: 4,
			themes: ['pricing', 'billing', 'transparency'],
		},
		{
			source: 'twitter',
			content: 'Support response time is awful. Opened a ticket 5 days ago for a production issue. Still waiting.',
			sentiment: 'negative',
			category: 'complaint',
			priority: 4,
			themes: ['support', 'response time'],
		},
		{
			source: 'github',
			content: 'The migration from older Workers syntax was a nightmare. Breaking changes with minimal guidance.',
			sentiment: 'negative',
			category: 'complaint',
			priority: 3,
			themes: ['migration', 'dx', 'documentation'],
		},
		{
			source: 'support',
			content: 'Tried to contact sales about enterprise plan for a week. No response. Going with AWS instead.',
			sentiment: 'negative',
			category: 'complaint',
			priority: 5,
			themes: ['sales', 'enterprise', 'support'],
		},

		// PRAISE - Positive (4 items)
		{
			source: 'twitter',
			content: 'Love the new dashboard update! So much cleaner and faster. Great work team! 🎉',
			sentiment: 'positive',
			category: 'praise',
			priority: 1,
			themes: ['dashboard', 'ui', 'performance'],
		},
		{
			source: 'discord',
			content: 'Just migrated from AWS Lambda to Workers. 10x faster cold starts and way cheaper. Incredibly impressed.',
			sentiment: 'positive',
			category: 'praise',
			priority: 1,
			themes: ['performance', 'pricing', 'migration'],
		},
		{
			source: 'github',
			content: 'The D1 team shipped that fix incredibly fast. Reported yesterday, patched today. Amazing support!',
			sentiment: 'positive',
			category: 'praise',
			priority: 1,
			themes: ['d1', 'support', 'reliability'],
		},
		{
			source: 'twitter',
			content: 'Workers AI is a game changer. Running LLMs at the edge with zero config? Mind blown. 🤯',
			sentiment: 'positive',
			category: 'praise',
			priority: 1,
			themes: ['workers ai', 'edge', 'innovation'],
		},
	];

	try {
		// Clear existing data first
		await env.DB.prepare('DELETE FROM feedback').run();

		// Insert all mock data
		const stmt = env.DB.prepare(
			`INSERT INTO feedback (source, content, sentiment, category, priority, themes) VALUES (?, ?, ?, ?, ?, ?)`
		);

		const insertPromises = mockFeedback.map((f) =>
			stmt
				.bind(f.source, f.content, f.sentiment, f.category, f.priority, JSON.stringify(f.themes))
				.run()
		);

		await Promise.all(insertPromises);

		// Get counts for response
		const counts = {
			total: mockFeedback.length,
			bysentiment: {
				negative: mockFeedback.filter((f) => f.sentiment === 'negative').length,
				neutral: mockFeedback.filter((f) => f.sentiment === 'neutral').length,
				positive: mockFeedback.filter((f) => f.sentiment === 'positive').length,
			},
			byCategory: {
				bug: mockFeedback.filter((f) => f.category === 'bug').length,
				feature: mockFeedback.filter((f) => f.category === 'feature').length,
				complaint: mockFeedback.filter((f) => f.category === 'complaint').length,
				praise: mockFeedback.filter((f) => f.category === 'praise').length,
			},
		};

		return Response.json({
			success: true,
			message: `Seeded ${mockFeedback.length} feedback entries`,
			counts,
		});
	} catch (error) {
		console.error('Error seeding database:', error);
		return Response.json({ error: 'Failed to seed database' }, { status: 500 });
	}
}

// =============================================================================
// FRONTEND DASHBOARD
// =============================================================================

function getDashboardHTML(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FeedPulse - Feedback Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
          },
          colors: {
            'cf-orange': '#F6821F',
            'cf-orange-hover': '#E5750E',
            'cf-navy': '#003682',
            'cf-blue': '#0051C3',
            'cf-blue-light': '#EBF5FF',
            positive: '#10B981',
            negative: '#EF4444',
            neutral: '#F59E0B',
          }
        }
      }
    }
  </script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    .loader {
      border: 2px solid #E5E7EB;
      border-top: 2px solid #F6821F;
      border-radius: 50%;
      width: 18px;
      height: 18px;
      animation: spin 0.8s linear infinite;
      display: inline-block;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .card { background: white; border: 1px solid #E5E7EB; border-radius: 8px; box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05); }
    .insight-card { background: white; border-left: 3px solid; padding: 12px 16px; border-radius: 0 6px 6px 0; }
    .btn-primary { background: #F6821F; color: white; border-radius: 6px; font-weight: 500; transition: background 0.15s; }
    .btn-primary:hover { background: #E5750E; }
    .btn-secondary { background: white; color: #374151; border: 1px solid #D1D5DB; border-radius: 6px; font-weight: 500; transition: all 0.15s; }
    .btn-secondary:hover { background: #F9FAFB; border-color: #9CA3AF; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen font-sans text-gray-700">
  <!-- Header -->
  <header class="bg-white border-b border-gray-200">
    <div class="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-3">
          <div class="w-9 h-9 bg-cf-orange rounded-md flex items-center justify-center">
            <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path>
            </svg>
          </div>
          <div>
            <h1 class="text-lg font-semibold text-gray-900">FeedPulse</h1>
            <p class="text-xs text-gray-500">Feedback Aggregation Dashboard</p>
          </div>
        </div>
        <div class="flex items-center space-x-2">
          <button onclick="exportCSV()" class="btn-secondary px-3 py-2 text-sm flex items-center space-x-2">
            <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"></path>
            </svg>
            <span>Export CSV</span>
          </button>
          <button onclick="loadAllData()" class="btn-primary px-4 py-2 text-sm flex items-center space-x-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"></path>
            </svg>
            <span>Refresh</span>
          </button>
        </div>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
    <!-- Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
      <div class="card p-5">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Feedback</p>
            <p id="stat-total" class="text-2xl font-semibold text-gray-900 mt-1">-</p>
            <p id="stat-total-time" class="text-xs text-gray-400 mt-1">All time</p>
          </div>
          <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"></path>
          </svg>
        </div>
      </div>

      <div class="card p-5">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">Positive</p>
            <p id="stat-positive" class="text-2xl font-semibold text-positive mt-1">-</p>
            <p id="stat-positive-time" class="text-xs text-gray-400 mt-1">All time</p>
          </div>
          <svg class="w-5 h-5 text-positive" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6.633 10.5c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 012.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 00.322-1.672V3a.75.75 0 01.75-.75A2.25 2.25 0 0116.5 4.5c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 01-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 00-1.423-.23H3.75"></path>
          </svg>
        </div>
      </div>

      <div class="card p-5">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">Negative</p>
            <p id="stat-negative" class="text-2xl font-semibold text-negative mt-1">-</p>
            <p id="stat-negative-time" class="text-xs text-gray-400 mt-1">All time</p>
          </div>
          <svg class="w-5 h-5 text-negative" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"></path>
          </svg>
        </div>
      </div>

      <div class="card p-5">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">Top Category</p>
            <p id="stat-category" class="text-2xl font-semibold text-gray-900 mt-1 capitalize">-</p>
            <p id="stat-category-time" class="text-xs text-gray-400 mt-1">All time</p>
          </div>
          <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z"></path>
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 6h.008v.008H6V6z"></path>
          </svg>
        </div>
      </div>
    </div>

    <!-- AI Insights Panel (Collapsible) -->
    <div class="mb-6">
      <button id="insights-toggle" onclick="toggleInsightsPanel()" class="flex items-center justify-between w-full px-4 py-3 card hover:bg-gray-50 transition-colors">
        <div class="flex items-center space-x-2">
          <svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148A12.061 12.061 0 0116.5 7.605"></path>
          </svg>
          <span class="font-medium text-gray-700">Insights</span>
        </div>
        <svg id="insights-chevron" class="w-4 h-4 text-gray-400 transform transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"></path>
        </svg>
      </button>

      <div id="insights-panel" class="mt-2 card overflow-hidden">
        <div class="p-5">
          <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <!-- Key Insights Card -->
            <div class="lg:col-span-1 space-y-3">
              <h3 class="text-xs font-medium text-gray-500 uppercase tracking-wide">Key Insights</h3>

              <!-- Most Urgent Issue -->
              <div class="insight-card" style="border-left-color: #EF4444;">
                <p class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Most Urgent Issue</p>
                <p id="urgent-issue" class="text-sm font-medium text-gray-900">Loading...</p>
                <p id="urgent-issue-detail" class="text-xs text-gray-500 mt-1"></p>
              </div>

              <!-- Trending Topic -->
              <div class="insight-card" style="border-left-color: #0051C3;">
                <p class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Trending Topic</p>
                <p id="trending-topic" class="text-sm font-medium text-gray-900">Loading...</p>
                <p id="trending-topic-detail" class="text-xs text-gray-500 mt-1"></p>
              </div>

              <!-- Sentiment Trend -->
              <div id="sentiment-trend-card" class="insight-card" style="border-left-color: #6B7280;">
                <p class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Sentiment Trend</p>
                <p id="sentiment-trend" class="text-sm font-medium text-gray-900">Loading...</p>
                <p id="sentiment-trend-detail" class="text-xs text-gray-500 mt-1"></p>
              </div>
            </div>

            <!-- Theme Distribution Chart -->
            <div class="lg:col-span-1">
              <h3 class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Theme Distribution</h3>
              <div id="theme-chart" class="space-y-2">
                <div class="flex items-center justify-center py-8">
                  <div class="loader"></div>
                </div>
              </div>
            </div>

            <!-- Quick Actions -->
            <div class="lg:col-span-1">
              <h3 class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Quick Actions</h3>
              <div class="space-y-2">
                <button onclick="filterByCategory('bug')" class="w-full flex items-center justify-between px-3 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-md hover:bg-gray-50 transition-colors text-sm">
                  <span class="flex items-center space-x-2">
                    <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 12.75c1.148 0 2.278.08 3.383.237 1.037.146 1.866.966 1.866 2.013 0 3.728-2.35 6.75-5.25 6.75S6.75 18.728 6.75 15c0-1.046.83-1.867 1.866-2.013A24.204 24.204 0 0112 12.75zm0 0c2.883 0 5.647.508 8.207 1.44a23.91 23.91 0 01-1.152 6.06M12 12.75c-2.883 0-5.647.508-8.208 1.44.125 2.104.52 4.136 1.153 6.06M12 12.75a2.25 2.25 0 002.248-2.354M12 12.75a2.25 2.25 0 01-2.248-2.354M12 8.25c.995 0 1.971-.08 2.922-.236.403-.066.74-.358.795-.762a3.778 3.778 0 00-.399-2.25M12 8.25c-.995 0-1.97-.08-2.922-.236-.402-.066-.74-.358-.795-.762a3.734 3.734 0 01.4-2.253M12 8.25a2.25 2.25 0 00-2.248 2.146M12 8.25a2.25 2.25 0 012.248 2.146M8.683 5a6.032 6.032 0 01-1.155-1.002c.07-.63.27-1.222.574-1.747m.581 2.749A3.75 3.75 0 0115.318 5m0 0c.427-.283.815-.62 1.155-.999a4.471 4.471 0 00-.575-1.752M4.921 6a24.048 24.048 0 00-.392 3.314c1.668.546 3.416.914 5.223 1.082M19.08 6c.205 1.08.337 2.187.392 3.314a23.882 23.882 0 01-5.223 1.082"></path>
                    </svg>
                    <span>View All Bugs</span>
                  </span>
                  <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"></path>
                  </svg>
                </button>

                <button onclick="filterByPriority()" class="w-full flex items-center justify-between px-3 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-md hover:bg-gray-50 transition-colors text-sm">
                  <span class="flex items-center space-x-2">
                    <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5"></path>
                    </svg>
                    <span>High Priority Items</span>
                  </span>
                  <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"></path>
                  </svg>
                </button>

                <button onclick="exportCSV()" class="w-full flex items-center justify-between px-3 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-md hover:bg-gray-50 transition-colors text-sm">
                  <span class="flex items-center space-x-2">
                    <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"></path>
                    </svg>
                    <span>Export Report (CSV)</span>
                  </span>
                  <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"></path>
                  </svg>
                </button>
              </div>

              <!-- Active Filters Indicator -->
              <div id="active-filters" class="mt-3 hidden">
                <div class="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-md border border-gray-200">
                  <span class="text-xs text-gray-600">Filter active</span>
                  <button onclick="clearFilters()" class="text-xs text-cf-orange hover:underline font-medium">Clear</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Left Column: Add Feedback + Themes -->
      <div class="space-y-4">
        <!-- Add Feedback Form -->
        <div class="card p-5">
          <h2 class="text-sm font-medium text-gray-700 mb-4">Add Test Feedback</h2>
          <form id="feedback-form" class="space-y-3">
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1.5">Source</label>
              <select id="form-source" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-cf-orange focus:border-cf-orange bg-white">
                <option value="twitter">Twitter</option>
                <option value="discord">Discord</option>
                <option value="github">GitHub</option>
                <option value="support">Support</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1.5">Feedback Content</label>
              <textarea id="form-content" rows="3" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-cf-orange focus:border-cf-orange" placeholder="Enter customer feedback..."></textarea>
            </div>
            <button type="submit" id="submit-btn" class="btn-primary w-full px-4 py-2 text-sm">
              Analyze & Submit
            </button>
          </form>
          <div id="form-result" class="mt-3 hidden"></div>
        </div>

        <!-- Themes Section -->
        <div class="card p-5">
          <h2 class="text-sm font-medium text-gray-700 mb-4">Detected Themes</h2>
          <div id="themes-container" class="space-y-2">
            <div class="flex items-center justify-center py-6">
              <div class="loader"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Right Column: Feedback Table -->
      <div class="lg:col-span-2">
        <div class="card overflow-hidden">
          <div class="px-5 py-4 border-b border-gray-200">
            <div class="flex items-center justify-between flex-wrap gap-3">
              <h2 class="text-sm font-medium text-gray-700">Recent Feedback</h2>
              <div class="flex flex-wrap gap-2">
                <select id="filter-daterange" class="px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:ring-2 focus:ring-cf-orange bg-white">
                  <option value="">All Time</option>
                  <option value="24h">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                </select>
                <select id="filter-sentiment" class="px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:ring-2 focus:ring-cf-orange bg-white">
                  <option value="">All Sentiments</option>
                  <option value="positive">Positive</option>
                  <option value="negative">Negative</option>
                  <option value="neutral">Neutral</option>
                </select>
                <select id="filter-source" class="px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:ring-2 focus:ring-cf-orange bg-white">
                  <option value="">All Sources</option>
                  <option value="twitter">Twitter</option>
                  <option value="discord">Discord</option>
                  <option value="github">GitHub</option>
                  <option value="support">Support</option>
                </select>
              </div>
            </div>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead class="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Source</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Content</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Sentiment</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Category</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Priority</th>
                  <th class="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Received</th>
                </tr>
              </thead>
              <tbody id="feedback-table" class="divide-y divide-gray-100">
                <tr>
                  <td colspan="6" class="px-4 py-8 text-center">
                    <div class="loader mx-auto"></div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <!-- Pagination Controls -->
          <div id="pagination-container" class="hidden px-5 py-3 border-t border-gray-200 bg-gray-50">
            <div class="flex items-center justify-between">
              <p id="pagination-info" class="text-xs text-gray-500">
                Showing 1-10 of 30 results
              </p>
              <div class="flex items-center space-x-1">
                <button id="prev-btn" class="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">
                  Previous
                </button>
                <div id="page-numbers" class="flex items-center space-x-1">
                  <!-- Page numbers will be inserted here -->
                </div>
                <button id="next-btn" class="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed">
                  Next
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <!-- Feedback Detail Modal -->
  <div id="feedback-modal" class="fixed inset-0 z-50 hidden overflow-y-auto">
    <div class="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
      <!-- Backdrop -->
      <div class="fixed inset-0 bg-gray-900/40 transition-opacity" onclick="closeModal()"></div>

      <!-- Modal Panel -->
      <div class="relative bg-white rounded-lg shadow-lg transform transition-all sm:max-w-lg sm:w-full mx-auto">
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div class="flex items-center space-x-3">
            <div id="modal-source-icon" class="w-8 h-8 rounded-md bg-gray-100 flex items-center justify-center"></div>
            <div>
              <h3 class="text-sm font-semibold text-gray-900">Feedback Details</h3>
              <p id="modal-source" class="text-xs text-gray-500"></p>
            </div>
          </div>
          <button onclick="closeModal()" class="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div class="px-5 py-4 space-y-4">
          <!-- Full Content -->
          <div>
            <label class="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Content</label>
            <p id="modal-content" class="text-gray-700 text-sm leading-relaxed bg-gray-50 rounded-md p-3 max-h-40 overflow-y-auto border border-gray-100"></p>
          </div>

          <!-- Themes -->
          <div>
            <label class="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Detected Themes</label>
            <div id="modal-themes" class="flex flex-wrap gap-1.5"></div>
          </div>

          <!-- Metadata Grid -->
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Sentiment</label>
              <span id="modal-sentiment" class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"></span>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Category</label>
              <span id="modal-category" class="text-sm text-gray-900 capitalize"></span>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Priority</label>
              <span id="modal-priority" class="text-sm"></span>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Created</label>
              <span id="modal-timestamp" class="text-sm text-gray-600"></span>
            </div>
          </div>

          <!-- Addressed Status -->
          <div id="modal-addressed-section" class="insight-card hidden" style="border-left-color: #10B981;">
            <div class="flex items-center space-x-2">
              <svg class="w-4 h-4 text-positive" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              <span class="text-sm text-gray-700">Marked as addressed</span>
              <span id="modal-addressed-at" class="text-xs text-gray-500"></span>
            </div>
          </div>
        </div>

        <!-- Actions -->
        <div class="px-5 py-3 bg-gray-50 rounded-b-lg flex justify-between border-t border-gray-200">
          <button onclick="copyFeedback()" class="btn-secondary inline-flex items-center px-3 py-1.5 text-sm">
            <svg class="w-4 h-4 mr-1.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"></path>
            </svg>
            Copy
          </button>
          <button id="modal-address-btn" onclick="toggleAddressed()" class="btn-primary inline-flex items-center px-3 py-1.5 text-sm">
            <svg class="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            Mark as Addressed
          </button>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Global state
    let allFeedback = [];
    let currentModalFeedback = null;
    let currentPage = 1;
    let totalPages = 1;
    let paginationInfo = null;

    // Panel state
    let insightsPanelOpen = true;
    let currentCategoryFilter = '';
    let currentPriorityFilter = '';
    let currentDateRangeFilter = '';

    // Get relative time string from a date
    function getRelativeTime(dateString) {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now - date;
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);
      const diffWeeks = Math.floor(diffDays / 7);
      const diffMonths = Math.floor(diffDays / 30);

      if (diffSecs < 60) return 'Just now';
      if (diffMins < 60) return \`\${diffMins} minute\${diffMins === 1 ? '' : 's'} ago\`;
      if (diffHours < 24) return \`\${diffHours} hour\${diffHours === 1 ? '' : 's'} ago\`;
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return \`\${diffDays} days ago\`;
      if (diffWeeks === 1) return '1 week ago';
      if (diffWeeks < 4) return \`\${diffWeeks} weeks ago\`;
      if (diffMonths === 1) return '1 month ago';
      if (diffMonths < 12) return \`\${diffMonths} months ago\`;
      return date.toLocaleDateString();
    }

    // Get display text for date range filter
    function getDateRangeDisplayText(value) {
      switch (value) {
        case '24h': return 'Last 24 hours';
        case '7d': return 'Last 7 days';
        case '30d': return 'Last 30 days';
        default: return 'All time';
      }
    }

    // Load all data on page load
    async function loadAllData() {
      await Promise.all([
        loadInsights(),
        loadFeedback(),
        loadThemes(),
        loadAIInsights()
      ]);
    }

    // Toggle insights panel
    function toggleInsightsPanel() {
      insightsPanelOpen = !insightsPanelOpen;
      const panel = document.getElementById('insights-panel');
      const chevron = document.getElementById('insights-chevron');

      if (insightsPanelOpen) {
        panel.classList.remove('hidden');
        chevron.classList.remove('rotate-180');
      } else {
        panel.classList.add('hidden');
        chevron.classList.add('rotate-180');
      }
    }

    // Modal Functions
    async function openFeedbackModal(feedbackId) {
      try {
        // Fetch full feedback details
        const res = await fetch(\`/api/feedback/\${feedbackId}\`);
        const data = await res.json();

        if (!data.success) {
          alert('Failed to load feedback details');
          return;
        }

        currentModalFeedback = data.feedback;
        const f = data.feedback;

        const sourceIconsSVG = {
          twitter: '<svg class="w-4 h-4 text-gray-500" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
          discord: '<svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg>',
          github: '<svg class="w-4 h-4 text-gray-500" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clip-rule="evenodd"/></svg>',
          support: '<svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.712 4.33a9.027 9.027 0 011.652 1.306c.51.51.944 1.064 1.306 1.652M16.712 4.33l-3.448 4.138m3.448-4.138a9.014 9.014 0 00-9.424 0M19.67 7.288l-4.138 3.448m4.138-3.448a9.014 9.014 0 010 9.424m-4.138-5.976a3.736 3.736 0 00-.88-1.388 3.737 3.737 0 00-1.388-.88m2.268 2.268a3.765 3.765 0 010 2.528m-2.268-4.796a3.765 3.765 0 00-2.528 0m4.796 4.796c-.181.506-.475.982-.88 1.388a3.736 3.736 0 01-1.388.88m2.268-2.268l4.138 3.448m0 0a9.027 9.027 0 01-1.306 1.652 9.027 9.027 0 01-1.652 1.306m0 0l-3.448-4.138m3.448 4.138a9.014 9.014 0 01-9.424 0m5.976-4.138a3.765 3.765 0 01-2.528 0m0 0a3.736 3.736 0 01-1.388-.88 3.737 3.737 0 01-.88-1.388m2.268 2.268L7.288 19.67m0 0a9.024 9.024 0 01-1.652-1.306 9.027 9.027 0 01-1.306-1.652m0 0l4.138-3.448M4.33 16.712a9.014 9.014 0 010-9.424m4.138 5.976a3.765 3.765 0 010-2.528m0 0c.181-.506.475-.982.88-1.388a3.736 3.736 0 011.388-.88m-2.268 2.268L4.33 7.288m6.406 1.18L7.288 4.33m0 0a9.024 9.024 0 00-1.652 1.306A9.025 9.025 0 004.33 7.288"/></svg>'
        };

        const sentimentColors = {
          positive: 'bg-green-50 text-green-700 border border-green-200',
          negative: 'bg-red-50 text-red-700 border border-red-200',
          neutral: 'bg-amber-50 text-amber-700 border border-amber-200'
        };

        // Populate modal
        document.getElementById('modal-source-icon').innerHTML = sourceIconsSVG[f.source] || sourceIconsSVG.support;
        document.getElementById('modal-source').textContent = \`From \${f.source}\`;
        document.getElementById('modal-content').textContent = f.content;

        // Themes
        const themesContainer = document.getElementById('modal-themes');
        themesContainer.innerHTML = (f.themes || []).map(t =>
          \`<span class="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">\${t}</span>\`
        ).join('');

        // Sentiment
        const sentimentEl = document.getElementById('modal-sentiment');
        sentimentEl.textContent = f.sentiment;
        sentimentEl.className = \`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium \${sentimentColors[f.sentiment]}\`;

        // Category
        document.getElementById('modal-category').textContent = f.category;

        // Priority - use dots instead of bars
        const priorityDots = Array(5).fill(0).map((_, i) =>
          i < f.priority
            ? '<span class="w-1.5 h-1.5 rounded-full bg-gray-900"></span>'
            : '<span class="w-1.5 h-1.5 rounded-full bg-gray-200"></span>'
        ).join('');
        const priorityEl = document.getElementById('modal-priority');
        priorityEl.innerHTML = \`<span class="flex items-center gap-0.5">\${priorityDots}</span><span class="ml-2 text-gray-500 text-xs">\${f.priority}/5</span>\`;
        priorityEl.className = \`flex items-center \${f.priority >= 4 ? 'text-red-600' : 'text-gray-700'}\`;

        // Timestamp
        const date = new Date(f.created_at);
        document.getElementById('modal-timestamp').textContent = date.toLocaleString();

        // Addressed status
        const addressedSection = document.getElementById('modal-addressed-section');
        const addressBtn = document.getElementById('modal-address-btn');

        if (f.addressed) {
          addressedSection.classList.remove('hidden');
          const addressedDate = f.addressed_at ? new Date(f.addressed_at).toLocaleString() : '';
          document.getElementById('modal-addressed-at').textContent = addressedDate ? \`on \${addressedDate}\` : '';
          addressBtn.innerHTML = \`
            <svg class="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
            Unmark
          \`;
          addressBtn.className = 'btn-secondary inline-flex items-center px-3 py-1.5 text-sm';
        } else {
          addressedSection.classList.add('hidden');
          addressBtn.innerHTML = \`
            <svg class="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
            </svg>
            Mark as Addressed
          \`;
          addressBtn.className = 'btn-primary inline-flex items-center px-3 py-1.5 text-sm';
        }

        // Show modal
        document.getElementById('feedback-modal').classList.remove('hidden');
        document.body.style.overflow = 'hidden';

      } catch (err) {
        console.error('Failed to open modal:', err);
        alert('Failed to load feedback details');
      }
    }

    function closeModal() {
      document.getElementById('feedback-modal').classList.add('hidden');
      document.body.style.overflow = '';
      currentModalFeedback = null;
    }

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && currentModalFeedback) {
        closeModal();
      }
    });

    async function copyFeedback() {
      if (!currentModalFeedback) return;

      const f = currentModalFeedback;
      const text = \`Feedback from \${f.source}:
Content: \${f.content}
Sentiment: \${f.sentiment}
Category: \${f.category}
Priority: \${f.priority}/5
Themes: \${(f.themes || []).join(', ')}
Created: \${f.created_at}\`;

      try {
        await navigator.clipboard.writeText(text);
        // Show brief success feedback
        const btn = event.target.closest('button');
        const originalHTML = btn.innerHTML;
        btn.innerHTML = \`
          <svg class="w-4 h-4 mr-2 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
          </svg>
          Copied!
        \`;
        setTimeout(() => { btn.innerHTML = originalHTML; }, 1500);
      } catch (err) {
        alert('Failed to copy to clipboard');
      }
    }

    async function toggleAddressed() {
      if (!currentModalFeedback) return;

      const newAddressed = !currentModalFeedback.addressed;

      try {
        const res = await fetch(\`/api/feedback/\${currentModalFeedback.id}\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addressed: newAddressed })
        });

        const data = await res.json();

        if (data.success) {
          // Update local state and re-render modal
          currentModalFeedback = data.feedback;
          openFeedbackModal(data.feedback.id);

          // Refresh the table to show updated status
          loadFeedback(
            document.getElementById('filter-sentiment').value,
            document.getElementById('filter-source').value,
            currentPage
          );
        } else {
          alert('Failed to update feedback');
        }
      } catch (err) {
        console.error('Failed to toggle addressed:', err);
        alert('Failed to update feedback');
      }
    }

    // Load AI Insights
    async function loadAIInsights() {
      try {
        const res = await fetch('/api/ai-insights');
        const data = await res.json();

        if (data.success) {
          const { aiInsights } = data;

          // Most Urgent Issue
          const urgentEl = document.getElementById('urgent-issue');
          const urgentDetailEl = document.getElementById('urgent-issue-detail');
          if (aiInsights.mostUrgentIssue) {
            urgentEl.textContent = aiInsights.mostUrgentIssue.theme;
            urgentDetailEl.textContent = \`Avg priority: \${aiInsights.mostUrgentIssue.avgPriority}/5 (\${aiInsights.mostUrgentIssue.count} mentions)\`;
          } else {
            urgentEl.textContent = 'No urgent issues';
            urgentDetailEl.textContent = '';
          }

          // Trending Topic
          const trendingEl = document.getElementById('trending-topic');
          const trendingDetailEl = document.getElementById('trending-topic-detail');
          if (aiInsights.trendingTopic) {
            trendingEl.textContent = aiInsights.trendingTopic.theme;
            trendingDetailEl.textContent = \`\${aiInsights.trendingTopic.recentMentions} mentions in recent feedback\`;
          } else {
            trendingEl.textContent = 'No trending topics';
            trendingDetailEl.textContent = '';
          }

          // Sentiment Trend
          const sentimentEl = document.getElementById('sentiment-trend');
          const sentimentDetailEl = document.getElementById('sentiment-trend-detail');
          const sentimentCard = document.getElementById('sentiment-trend-card');

          if (aiInsights.sentimentTrend) {
            const trend = aiInsights.sentimentTrend;
            sentimentEl.textContent = trend.trend.charAt(0).toUpperCase() + trend.trend.slice(1);
            sentimentDetailEl.textContent = trend.description;

            // Update card border color based on trend
            const borderColor = trend.trend === 'improving' ? '#10B981' :
              trend.trend === 'declining' ? '#EF4444' : '#6B7280';
            sentimentCard.style.borderLeftColor = borderColor;
          }

          // Theme Distribution Chart
          renderThemeChart(aiInsights.themeDistribution);
        }
      } catch (err) {
        console.error('Failed to load AI insights:', err);
      }
    }

    // Render theme distribution bar chart
    function renderThemeChart(themes) {
      const container = document.getElementById('theme-chart');

      if (!themes || themes.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-xs text-center py-4">No theme data yet</p>';
        return;
      }

      const maxCount = Math.max(...themes.map(t => t.count));
      const colors = ['bg-gray-600', 'bg-gray-500', 'bg-gray-400', 'bg-gray-400', 'bg-gray-300'];

      container.innerHTML = themes.map((t, i) => \`
        <div class="space-y-1">
          <div class="flex justify-between text-xs">
            <span class="text-gray-600 truncate" title="\${t.theme}">\${t.theme}</span>
            <span class="text-gray-400">\${t.percentage}%</span>
          </div>
          <div class="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div class="\${colors[i % colors.length]} h-full rounded-full transition-all duration-300" style="width: \${(t.count / maxCount) * 100}%"></div>
          </div>
        </div>
      \`).join('');
    }

    // Filter by category (for quick actions)
    async function filterByCategory(category) {
      currentCategoryFilter = category;
      currentPriorityFilter = '';

      // Reset the dropdown filters (but keep date range)
      document.getElementById('filter-sentiment').value = '';
      document.getElementById('filter-source').value = '';
      const dateRange = document.getElementById('filter-daterange').value;

      // Show active filter indicator
      document.getElementById('active-filters').classList.remove('hidden');

      // Fetch filtered data
      let url = \`/api/feedback?category=\${category}&page=1&limit=10\`;
      if (dateRange) url += \`&dateRange=\${dateRange}\`;

      const res = await fetch(url);
      const data = await res.json();

      if (data.success) {
        allFeedback = data.feedback;
        paginationInfo = data.pagination;
        currentPage = data.pagination.page;
        totalPages = data.pagination.totalPages;
        renderFeedbackTable(data.feedback);
        renderPagination(data.pagination);
      }

      // Scroll to table
      document.getElementById('feedback-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Filter by high priority (for quick actions)
    async function filterByPriority() {
      currentPriorityFilter = '4';
      currentCategoryFilter = '';

      // Reset the dropdown filters (but keep date range)
      document.getElementById('filter-sentiment').value = '';
      document.getElementById('filter-source').value = '';
      const dateRange = document.getElementById('filter-daterange').value;

      // Show active filter indicator
      document.getElementById('active-filters').classList.remove('hidden');

      // Fetch high priority items (priority >= 4)
      let url = '/api/feedback?priority=4&page=1&limit=10';
      if (dateRange) url += \`&dateRange=\${dateRange}\`;

      const res = await fetch(url);
      const data = await res.json();

      if (data.success) {
        allFeedback = data.feedback;
        paginationInfo = data.pagination;
        currentPage = data.pagination.page;
        totalPages = data.pagination.totalPages;
        renderFeedbackTable(data.feedback);
        renderPagination(data.pagination);
      }

      // Scroll to table
      document.getElementById('feedback-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Clear all filters
    function clearFilters() {
      currentCategoryFilter = '';
      currentPriorityFilter = '';
      currentDateRangeFilter = '';
      document.getElementById('filter-sentiment').value = '';
      document.getElementById('filter-source').value = '';
      document.getElementById('filter-daterange').value = '';
      document.getElementById('active-filters').classList.add('hidden');
      loadFeedback('', '', 1, '');
    }

    // Export current feedback to CSV
    async function exportCSV() {
      try {
        // Fetch all feedback (no pagination limit for export)
        const sentiment = document.getElementById('filter-sentiment').value;
        const source = document.getElementById('filter-source').value;
        const dateRange = document.getElementById('filter-daterange').value;

        let url = '/api/feedback?limit=1000';
        if (sentiment) url += \`&sentiment=\${sentiment}\`;
        if (source) url += \`&source=\${source}\`;
        if (dateRange) url += \`&dateRange=\${dateRange}\`;
        if (currentCategoryFilter) url += \`&category=\${currentCategoryFilter}\`;
        if (currentPriorityFilter) url += \`&priority=\${currentPriorityFilter}\`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.success && data.feedback.length > 0) {
          // Create CSV content
          const headers = ['ID', 'Source', 'Content', 'Sentiment', 'Category', 'Priority', 'Themes', 'Created At'];
          const rows = data.feedback.map(f => [
            f.id,
            f.source,
            \`"\${(f.content || '').replace(/"/g, '""')}"\`,
            f.sentiment,
            f.category,
            f.priority,
            \`"\${(f.themes || []).join(', ')}"\`,
            f.created_at
          ]);

          const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\\n');

          // Download
          const blob = new Blob([csv], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = \`feedpulse-export-\${new Date().toISOString().split('T')[0]}.csv\`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          alert('No data to export');
        }
      } catch (err) {
        console.error('Export failed:', err);
        alert('Failed to export data');
      }
    }

    // Load insights/stats
    async function loadInsights() {
      try {
        const res = await fetch('/api/insights');
        const data = await res.json();

        if (data.success) {
          const { insights } = data;
          document.getElementById('stat-total').textContent = insights.total;
          document.getElementById('stat-positive').textContent = insights.sentiment.positive || 0;
          document.getElementById('stat-negative').textContent = insights.sentiment.negative || 0;

          // Find top category
          const categories = Object.entries(insights.categories);
          if (categories.length > 0) {
            const topCategory = categories.sort((a, b) => b[1] - a[1])[0][0];
            document.getElementById('stat-category').textContent = topCategory;
          }
        }
      } catch (err) {
        console.error('Failed to load insights:', err);
      }
    }

    // Load feedback list with pagination
    async function loadFeedback(sentiment = '', source = '', page = 1, dateRange = '') {
      const tbody = document.getElementById('feedback-table');
      tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-8 text-center"><div class="loader mx-auto"></div></td></tr>';

      // Hide pagination while loading
      document.getElementById('pagination-container').classList.add('hidden');

      try {
        const params = new URLSearchParams();
        if (sentiment) params.append('sentiment', sentiment);
        if (source) params.append('source', source);
        if (dateRange) params.append('dateRange', dateRange);
        params.append('page', page.toString());
        params.append('limit', '10');

        const res = await fetch('/api/feedback?' + params.toString());
        const data = await res.json();

        if (data.success) {
          allFeedback = data.feedback;
          paginationInfo = data.pagination;
          currentPage = data.pagination.page;
          totalPages = data.pagination.totalPages;

          renderFeedbackTable(data.feedback);
          renderPagination(data.pagination);

          // Update stats time context labels
          const timeText = getDateRangeDisplayText(dateRange);
          document.getElementById('stat-total-time').textContent = timeText;
          document.getElementById('stat-positive-time').textContent = timeText;
          document.getElementById('stat-negative-time').textContent = timeText;
          document.getElementById('stat-category-time').textContent = timeText;
        }
      } catch (err) {
        console.error('Failed to load feedback:', err);
        tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-8 text-center text-red-500">Failed to load feedback</td></tr>';
      }
    }

    // Render pagination controls
    function renderPagination(pagination) {
      const container = document.getElementById('pagination-container');
      const info = document.getElementById('pagination-info');
      const pageNumbers = document.getElementById('page-numbers');
      const prevBtn = document.getElementById('prev-btn');
      const nextBtn = document.getElementById('next-btn');

      if (pagination.total === 0) {
        container.classList.add('hidden');
        return;
      }

      container.classList.remove('hidden');

      // Update info text
      const start = (pagination.page - 1) * pagination.limit + 1;
      const end = Math.min(pagination.page * pagination.limit, pagination.total);
      info.textContent = \`Showing \${start}-\${end} of \${pagination.total} results\`;

      // Update prev/next buttons
      prevBtn.disabled = !pagination.hasPrev;
      nextBtn.disabled = !pagination.hasNext;

      // Generate page numbers
      pageNumbers.innerHTML = '';
      const maxVisiblePages = 5;
      let startPage = Math.max(1, pagination.page - Math.floor(maxVisiblePages / 2));
      let endPage = Math.min(pagination.totalPages, startPage + maxVisiblePages - 1);

      // Adjust start if we're near the end
      if (endPage - startPage < maxVisiblePages - 1) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
      }

      // First page + ellipsis
      if (startPage > 1) {
        pageNumbers.innerHTML += \`<button onclick="goToPage(1)" class="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50">1</button>\`;
        if (startPage > 2) {
          pageNumbers.innerHTML += \`<span class="px-1 text-gray-400 text-xs">...</span>\`;
        }
      }

      // Page numbers
      for (let i = startPage; i <= endPage; i++) {
        const isActive = i === pagination.page;
        const activeClass = isActive
          ? 'bg-gray-900 text-white border-gray-900'
          : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50';
        pageNumbers.innerHTML += \`<button onclick="goToPage(\${i})" class="px-2.5 py-1 text-xs font-medium border rounded-md \${activeClass}">\${i}</button>\`;
      }

      // Last page + ellipsis
      if (endPage < pagination.totalPages) {
        if (endPage < pagination.totalPages - 1) {
          pageNumbers.innerHTML += \`<span class="px-1 text-gray-400 text-xs">...</span>\`;
        }
        pageNumbers.innerHTML += \`<button onclick="goToPage(\${pagination.totalPages})" class="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-md hover:bg-gray-50">\${pagination.totalPages}</button>\`;
      }
    }

    // Navigate to a specific page
    function goToPage(page) {
      const sentiment = document.getElementById('filter-sentiment').value;
      const source = document.getElementById('filter-source').value;
      const dateRange = document.getElementById('filter-daterange').value;
      loadFeedback(sentiment, source, page, dateRange);
    }

    // Previous page
    function prevPage() {
      if (currentPage > 1) {
        goToPage(currentPage - 1);
      }
    }

    // Next page
    function nextPage() {
      if (currentPage < totalPages) {
        goToPage(currentPage + 1);
      }
    }

    // Render feedback table
    function renderFeedbackTable(feedback) {
      const tbody = document.getElementById('feedback-table');

      if (feedback.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-8 text-center text-gray-500 text-sm">No feedback yet. Add some using the form.</td></tr>';
        return;
      }

      const sourceIconsSVG = {
        twitter: '<svg class="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
        discord: '<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>',
        github: '<svg class="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clip-rule="evenodd"/></svg>',
        support: '<svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.712 4.33a9.027 9.027 0 011.652 1.306c.51.51.944 1.064 1.306 1.652M16.712 4.33l-3.448 4.138m3.448-4.138a9.014 9.014 0 00-9.424 0M19.67 7.288l-4.138 3.448m4.138-3.448a9.014 9.014 0 010 9.424m-4.138-5.976a3.736 3.736 0 00-.88-1.388 3.737 3.737 0 00-1.388-.88m2.268 2.268a3.765 3.765 0 010 2.528m-2.268-4.796a3.765 3.765 0 00-2.528 0m4.796 4.796c-.181.506-.475.982-.88 1.388a3.736 3.736 0 01-1.388.88m2.268-2.268l4.138 3.448m0 0a9.027 9.027 0 01-1.306 1.652 9.027 9.027 0 01-1.652 1.306m0 0l-3.448-4.138m3.448 4.138a9.014 9.014 0 01-9.424 0m5.976-4.138a3.765 3.765 0 01-2.528 0m0 0a3.736 3.736 0 01-1.388-.88 3.737 3.737 0 01-.88-1.388m2.268 2.268L7.288 19.67m0 0a9.024 9.024 0 01-1.652-1.306 9.027 9.027 0 01-1.306-1.652m0 0l4.138-3.448M4.33 16.712a9.014 9.014 0 010-9.424m4.138 5.976a3.765 3.765 0 010-2.528m0 0c.181-.506.475-.982.88-1.388a3.736 3.736 0 011.388-.88m-2.268 2.268L4.33 7.288m6.406 1.18L7.288 4.33m0 0a9.024 9.024 0 00-1.652 1.306A9.025 9.025 0 004.33 7.288"/></svg>'
      };

      const sentimentColors = {
        positive: 'bg-green-50 text-green-700',
        negative: 'bg-red-50 text-red-700',
        neutral: 'bg-amber-50 text-amber-700'
      };

      tbody.innerHTML = feedback.map(f => {
        // Truncate content if longer than 100 chars
        const maxLength = 100;
        const isLong = f.content && f.content.length > maxLength;
        const displayContent = isLong ? f.content.substring(0, maxLength) + '...' : f.content;
        const showMoreLink = isLong ? '<span class="text-cf-orange text-xs ml-1">more</span>' : '';

        // Addressed indicator
        const addressedBadge = f.addressed ? '<svg class="w-3.5 h-3.5 text-positive ml-1.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>' : '';

        // Priority dots
        const priorityDots = Array(5).fill(0).map((_, i) =>
          i < f.priority
            ? '<span class="w-1.5 h-1.5 rounded-full ' + (f.priority >= 4 ? 'bg-red-500' : 'bg-gray-600') + '"></span>'
            : '<span class="w-1.5 h-1.5 rounded-full bg-gray-200"></span>'
        ).join('');

        // Relative time
        const relativeTime = getRelativeTime(f.created_at);
        const fullDate = new Date(f.created_at).toLocaleString();

        return \`
          <tr class="hover:bg-gray-50 cursor-pointer transition-colors" onclick="openFeedbackModal(\${f.id})">
            <td class="px-4 py-3 whitespace-nowrap">
              <div class="flex items-center space-x-2">
                \${sourceIconsSVG[f.source] || sourceIconsSVG.support}
                <span class="text-xs text-gray-600 capitalize">\${f.source}</span>
              </div>
            </td>
            <td class="px-4 py-3">
              <div class="text-sm text-gray-700 max-w-xs">
                <span>\${displayContent}</span>\${showMoreLink}
              </div>
              <div class="flex flex-wrap gap-1 mt-1">
                \${(f.themes || []).slice(0, 2).map(t => \`<span class="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-500 rounded">\${t}</span>\`).join('')}
                \${(f.themes || []).length > 2 ? \`<span class="px-1.5 py-0.5 text-xs bg-gray-100 text-gray-500 rounded">+\${f.themes.length - 2}</span>\` : ''}
              </div>
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              <span class="px-2 py-0.5 text-xs font-medium rounded \${sentimentColors[f.sentiment]}">\${f.sentiment}</span>\${addressedBadge}
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              <span class="text-xs text-gray-600 capitalize">\${f.category}</span>
            </td>
            <td class="px-4 py-3 whitespace-nowrap">
              <div class="flex items-center gap-0.5">\${priorityDots}</div>
            </td>
            <td class="px-4 py-3 whitespace-nowrap" title="\${fullDate}">
              <span class="text-xs text-gray-500">\${relativeTime}</span>
            </td>
          </tr>
        \`;
      }).join('');
    }

    // Load themes
    async function loadThemes() {
      const container = document.getElementById('themes-container');

      try {
        const res = await fetch('/api/themes');
        const data = await res.json();

        if (data.success && data.themes.length > 0) {
          container.innerHTML = data.themes.slice(0, 8).map(t => \`
            <div class="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-md border border-gray-100">
              <span class="text-sm text-gray-700">\${t.theme}</span>
              <span class="text-xs text-gray-500 font-medium">\${t.count}</span>
            </div>
          \`).join('');
        } else {
          container.innerHTML = '<p class="text-gray-400 text-xs text-center py-4">No themes detected yet</p>';
        }
      } catch (err) {
        console.error('Failed to load themes:', err);
        container.innerHTML = '<p class="text-red-500 text-sm text-center py-4">Failed to load themes</p>';
      }
    }

    // Handle form submission
    document.getElementById('feedback-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const submitBtn = document.getElementById('submit-btn');
      const resultDiv = document.getElementById('form-result');
      const source = document.getElementById('form-source').value;
      const content = document.getElementById('form-content').value.trim();

      if (!content) {
        resultDiv.className = 'mt-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm';
        resultDiv.textContent = 'Please enter feedback content';
        resultDiv.classList.remove('hidden');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="loader mr-2"></span> Analyzing...';

      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, content })
        });

        const data = await res.json();

        if (data.success) {
          resultDiv.className = 'mt-4 p-3 bg-green-50 text-green-700 rounded-lg text-sm';
          resultDiv.innerHTML = \`
            <strong>Analyzed!</strong><br>
            Sentiment: \${data.feedback.sentiment} | Category: \${data.feedback.category} | Priority: \${data.feedback.priority}<br>
            Themes: \${data.feedback.themes.join(', ') || 'none'}
          \`;
          document.getElementById('form-content').value = '';
          loadAllData(); // Refresh all data
        } else {
          resultDiv.className = 'mt-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm';
          resultDiv.textContent = data.error || 'Failed to submit feedback';
        }
      } catch (err) {
        resultDiv.className = 'mt-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm';
        resultDiv.textContent = 'Network error. Please try again.';
      }

      resultDiv.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Analyze & Submit';
    });

    // Handle filter changes - reset to page 1 when filters change
    document.getElementById('filter-daterange').addEventListener('change', (e) => {
      const sentiment = document.getElementById('filter-sentiment').value;
      const source = document.getElementById('filter-source').value;
      currentDateRangeFilter = e.target.value;
      loadFeedback(sentiment, source, 1, e.target.value); // Reset to page 1
    });

    document.getElementById('filter-sentiment').addEventListener('change', (e) => {
      const source = document.getElementById('filter-source').value;
      const dateRange = document.getElementById('filter-daterange').value;
      loadFeedback(e.target.value, source, 1, dateRange); // Reset to page 1
    });

    document.getElementById('filter-source').addEventListener('change', (e) => {
      const sentiment = document.getElementById('filter-sentiment').value;
      const dateRange = document.getElementById('filter-daterange').value;
      loadFeedback(sentiment, e.target.value, 1, dateRange); // Reset to page 1
    });

    // Pagination button handlers
    document.getElementById('prev-btn').addEventListener('click', prevPage);
    document.getElementById('next-btn').addEventListener('click', nextPage);

    // Initial load
    loadAllData();
  </script>
</body>
</html>`;
}

// =============================================================================
// ROUTER
// =============================================================================

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		// CORS headers for API routes
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle CORS preflight
		if (method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// API Routes
			if (path === '/api/feedback' && method === 'POST') {
				const response = await handlePostFeedback(request, env);
				return addCorsHeaders(response, corsHeaders);
			}

			if (path === '/api/feedback' && method === 'GET') {
				const response = await handleGetFeedback(request, env);
				return addCorsHeaders(response, corsHeaders);
			}

			// Single feedback item routes (GET and PATCH)
			const feedbackIdMatch = path.match(/^\/api\/feedback\/(\d+)$/);
			if (feedbackIdMatch) {
				const id = feedbackIdMatch[1];
				if (method === 'GET') {
					const response = await handleGetFeedbackById(id, env);
					return addCorsHeaders(response, corsHeaders);
				}
				if (method === 'PATCH') {
					const response = await handlePatchFeedback(id, request, env);
					return addCorsHeaders(response, corsHeaders);
				}
			}

			if (path === '/api/insights' && method === 'GET') {
				const response = await handleGetInsights(env);
				return addCorsHeaders(response, corsHeaders);
			}

			if (path === '/api/themes' && method === 'GET') {
				const response = await handleGetThemes(env);
				return addCorsHeaders(response, corsHeaders);
			}

			if (path === '/api/ai-insights' && method === 'GET') {
				const response = await handleGetAIInsights(env);
				return addCorsHeaders(response, corsHeaders);
			}

			if (path === '/api/seed' && method === 'POST') {
				const response = await handleSeed(env);
				return addCorsHeaders(response, corsHeaders);
			}

			// Serve dashboard for root and any non-API routes
			if (path === '/' || !path.startsWith('/api')) {
				return new Response(getDashboardHTML(), {
					headers: { 'Content-Type': 'text/html' },
				});
			}

			// 404 for unknown API routes
			return Response.json({ error: 'Not found' }, { status: 404 });
		} catch (error) {
			console.error('Unhandled error:', error);
			return Response.json({ error: 'Internal server error' }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

// Helper to add CORS headers to response
function addCorsHeaders(response: Response, corsHeaders: Record<string, string>): Response {
	const newHeaders = new Headers(response.headers);
	Object.entries(corsHeaders).forEach(([key, value]) => {
		newHeaders.set(key, value);
	});
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: newHeaders,
	});
}
