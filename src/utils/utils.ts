import * as Debug from 'debug';
import {Page, Request, LoadEvent} from 'puppeteer';
import {
	PromiseAllSettledFulfilled,
	PromiseAllSettledRejected,
	Tracker
} from '../types';
import memoizee = require('memoizee');
import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import {DEFAULT} from '../settings/settings';
import {getLogNormalScore, sum, groupBy} from '../bin/statistics';
import {
	AuditByFailOrPassOrSkip,
	Meta,
	SkipMeta,
	AuditReportFormat,
	SuccessOrFailureMeta,
	AuditsByCategory,
	Result
} from '../types/audit';

export function debugGenerator(namespace: string): Debug.IDebugger {
	const debug = Debug(`sustainability: ${namespace}`);
	return debug;
}

const logToConsole = Debug('sustainability:log');
logToConsole.log = console.error.bind(console);

export function log(message: string): void {
	logToConsole(message);
}

export function toHexString(codePointArray: number[]): string[] {
	return codePointArray.map(
		codePoint => 'U+' + codePoint.toString(16).toUpperCase()
	);
}

// Scroll function credits to nagy.zsolt.hun https://stackoverflow.com/questions/51529332/puppeteer-scroll-down-until-you-cant-anymore
export async function scrollFunction(
	page: Page,
	maxScrollInterval: number,
	debug?: CallableFunction
): Promise<any> {
	if (debug) {
		debug('running scroll function');
	}

	return page.evaluate(
		maxScrollInterval =>
			new Promise(resolve => {
				let scrollTop = -1;
				const interval = setInterval(() => {
					window.scrollBy(0, 100);
					if (document.documentElement.scrollTop !== scrollTop) {
						scrollTop = document.documentElement.scrollTop;
						return;
					}

					clearInterval(interval);
					resolve();
				}, maxScrollInterval);
			}),
		maxScrollInterval
	);
}

export function parseAllSettled(
	data: Array<PromiseAllSettledRejected | PromiseAllSettledFulfilled>,
	audit?: boolean
): any {
	const parser = (
		res: PromiseAllSettledFulfilled | PromiseAllSettledRejected
	) => {
		if (res.status === 'fulfilled' && res.value) {
			return res.value;
		}

		if (res.status === 'rejected') {
			return safeReject(new Error(`Failed with error: ${res.reason}`));
		}
	};

	const result = data.map(res => {
		return parser(res);
	});

	if (!audit) {
		return Object.assign({}, ...result);
	}

	return (
		result
			.filter(data => data)
			// @ts-ignore
			.flatMap((data: any) => {
				const isArray = Array.isArray(data);
				if (isArray) {
					return data.map((d: any) => d.value);
				}

				return data;
			})
	);
}

export function safeReject(error: Error, tracker?: Tracker) {
	if (tracker) {
		if (error.message.startsWith('Navigation timeout')) {
			const urls = tracker.urls();
			if (urls.length > 1) {
				error.message += `\nTracked URLs that have not finished: ${urls.join(
					', '
				)}`;
			} else if (urls.length > 0) {
				error.message += `\nFor ${urls[0]}`;
			}

			tracker.dispose();
		}
	}

	throw new Error(`Error: Navigation failed with message: ${error.message}`);
}

export function createTracker(page: Page): Tracker {
	const requests = new Set<Request>();
	const onStarted = (request: Request) => requests.add(request);
	const onFinished = (request: Request) => requests.delete(request);
	page.on('request', onStarted);
	page.on('requestfinished', onFinished);
	page.on('requestfailed', onFinished);
	return {
		urls: () => Array.from(requests).map((r: any) => r.url()),
		dispose: () => {
			page.removeListener('request', onStarted);
			page.removeListener('requestfinished', onFinished);
			page.removeListener('requestfailed', onFinished);
		}
	};
}

const GREEN_SERVER_API = 'http://api.thegreenwebfoundation.org/greencheck';

interface APIResponse {
	green: boolean;
	url: string;
	hostedby: string;
	hostedbywebsite: string;
	error?: string;
}
const isGreenServer = async (
	hostname: string
): Promise<APIResponse | undefined> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, DEFAULT.CONNECTION_SETTINGS.maxThrottle);
	const url = `${GREEN_SERVER_API}/${hostname}`;
	try {
		const response = await fetch(url, {
			signal: controller.signal
		});

		const responseToJson = await response.json();

		return responseToJson;
	} catch (error) {
		log(
			`Error: Failed to fetch response from green server API. ${error.message} ${url}`
		);
		return await new Promise(resolve => resolve(undefined));
	} finally {
		clearTimeout(timeout);
	}
};

export const isGreenServerMem = memoizee(isGreenServer, {async: true});

export async function safeNavigateTimeout(
	page: Page,
	waitUntil: LoadEvent,
	maxNavigationTime: number,
	debug?: CallableFunction,
	cb?: CallableFunction
) {
	if (debug) {
		debug('Waiting for navigation to load');
	}

	let stopCallback: any = null;
	const navigate = async () => {
		await page.waitForNavigation({waitUntil});
		clearTimeout(stopNavigation);
	};

	const stopPromise = new Promise(x => (stopCallback = x));
	const stopNavigation = setTimeout(() => stopCallback(cb), maxNavigationTime);
	return Promise.race([navigate(), stopPromise]);
}

/**
 * Credits to Google Lighthouse
 *
 * Computes a score between 0 and 1 based on the measured `value`. Score is determined by
 * considering a log-normal distribution governed by two control points (the 10th
 * percentile value and the median value) and represents the percentage of sites that are
 * greater than `value`.
 *
 */
export function computeLogNormalScore(
	controlPoints: {median: number; p10: number},
	value: number
): number {
	const percentile = getLogNormalScore(controlPoints, value);

	return clampTo2Decimals(percentile);
}

export const clampTo2Decimals = (value: number) =>
	Math.round(value * 100) / 100;

/**
 * @description Computes a global calculated as the average sum of category scores.
 */
export function computeScore(audits: any) {
	return Math.round(sum(audits.map((audit: any) => audit.score)) / 2);
}

export function groupAudits(list: Result[]): AuditsByCategory[] {
	const resultsGrouped = groupBy(list, (audit: Result) => audit.meta.category);
	const audits = Array.from(resultsGrouped.keys()).map(
		(key: 'server' | 'design') => {
			const groupByKey = resultsGrouped.get(key);
			const auditsByFailOrPassOrSkip = successOrFailureOrSkipAudits(groupByKey);
			const groupByKeyNonSkip = groupByKey.filter(
				(result: Result) => result.scoreDisplayMode !== 'skip'
			);
			const auditScoreRaw =
				sum(groupByKeyNonSkip.map((result: Result) => result.score)) /
				groupByKeyNonSkip.length;
			const auditScore = Math.round(auditScoreRaw * 100);
			const catDescription = DEFAULT.CATEGORIES[key].description;

			return {
				category: {name: key, description: catDescription},
				score: auditScore,
				audits: auditsByFailOrPassOrSkip
			};
		}
	);

	return audits;
}

export function successOrFailureMeta(
	meta: Meta,
	score: number
): SuccessOrFailureMeta {
	const {title, failureTitle, collectors, ...output} = meta;

	if (hasFailed(score)) {
		return {title: failureTitle, ...output};
	}

	return {title, ...output};
}

export function skipMeta(meta: Meta): SkipMeta {
	return {id: meta.id, category: meta.category, description: meta.description};
}

export function hasFailed(score: number) {
	if (score === 0 || score <= 0.49) {
		return true;
	}

	return false;
}

export function successOrFailureOrSkipAudits(
	audits: AuditReportFormat[]
): AuditByFailOrPassOrSkip {
	const out = audits.reduce(
		(object, v) => {
			const skipAudit = v.scoreDisplayMode === 'skip';
			(skipAudit
				? object.skip
				: hasFailed(v.score)
				? object.fail
				: object.pass
			).push(v);
			return object;
		},
		{pass: [], fail: [], skip: []} as AuditByFailOrPassOrSkip
	);

	return out;
}

export function removeQuotes(text: string): string {
	if (text.startsWith(`’`)) {
		return text.replace(/'/g, '');
	}

	if (text.startsWith('"')) {
		return text.replace(/"/g, '');
	}

	return text;
}
