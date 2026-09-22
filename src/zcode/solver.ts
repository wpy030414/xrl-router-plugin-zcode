/**
 * zcode/solver.ts — 以子进程方式调用无痕验证求解器。
 *
 * 求解器（captcha/solver.cjs）需要 jsdom + runScripts:'dangerously' 跑阿里云
 * 混淆 SDK，隔离在子进程里可以由超时强杀、崩溃不污染主进程。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { settings } from '../config';

export interface SolverParams {
  sceneId: string;
  region: string;
  prefix: string;
}

/**
 * 调用求解器求一次 verifyParam。失败一律抛错（由 CaptchaManager 决定重试）。
 */
export function solveVerifyParam(params: SolverParams): Promise<string> {
  return new Promise((resolve, reject) => {
    const { nodePath, solverPath, timeoutMs } = settings.captcha;

    const child = spawn(
      nodePath,
      [solverPath, params.sceneId, params.region, params.prefix],
      { cwd: path.dirname(solverPath), stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error(`求解器超时（${timeoutMs}ms）`));
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      finish(() => reject(new Error(`无法启动求解器（${nodePath}）: ${err.message}`)));
    });

    child.on('close', (code) => {
      finish(() => {
        for (const line of stdout.split(/\r?\n/)) {
          if (line.startsWith('VERIFY_PARAM=')) {
            const param = line.slice('VERIFY_PARAM='.length).trim();
            if (param) return resolve(param);
          }
        }
        const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ');
        reject(new Error(`求解器退出码 ${code}，未取到 VERIFY_PARAM${tail ? `：${tail}` : ''}`));
      });
    });
  });
}
