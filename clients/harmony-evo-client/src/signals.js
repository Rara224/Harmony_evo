const SIGNAL_PATTERNS = [
  { signal: 'harmony_error_code', regex: /\b\d{6,9}\b/g },
  { signal: 'hvigor_build_fail', regex: /hvigor|build-profile|signingConfigs|signature file|hap|hsp|编译|打包|签名/i },
  { signal: 'permission_issue', regex: /permission|requestPermissionsFromUser|ohos\.permission|权限|授权|弹窗/i },
  { signal: 'ability_issue', regex: /ability|startAbility|AbilityStage|launchType|module\.json5|页面跳转/i },
  { signal: 'arkui_issue', regex: /arkui|List|LazyForEach|ForEach|Canvas|Hds|RichEditor|Navigation|组件|画布|布局/i },
  { signal: 'network_issue', regex: /http|fetch|request|ERR_CLEARTEXT|network|网络|连接/i },
  { signal: 'performance_issue', regex: /lag|jank|fps|oom|out of memory|卡顿|掉帧|内存|性能/i },
  { signal: 'push_issue', regex: /push|getToken|PushService|907135702|推送|token/i },
  { signal: 'router_issue', regex: /router\.push|router\.replace|page stack|页面栈|路由/i },
  { signal: 'test_failure', regex: /test failed|assertion|expect\(|failed|error:|exception|报错|失败/i },
];

function detectSignals(text) {
  const source = String(text || '');
  const signals = [];
  const errorCodes = new Set();

  for (const item of SIGNAL_PATTERNS) {
    if (item.signal === 'harmony_error_code') {
      item.regex.lastIndex = 0;
      let match;
      while ((match = item.regex.exec(source))) {
        const value = match[0];
        const nearby = source.slice(Math.max(0, match.index - 32), match.index + value.length + 32);
        const hasErrorCodeContext = /error[_\s-]*code|err[_\s-]*code|错误码|错误代码/i.test(nearby);
        const looksLikeRuntimeNumber = /timeout|timestamp|created|start|end|tokens|total|input|output|reasoning|cache|port|pid/i.test(nearby);
        const commonTimeout = /^(7000|10000|30000|60000|120000)$/.test(value);
        if ((looksLikeRuntimeNumber || commonTimeout) && !hasErrorCodeContext) continue;
        errorCodes.add(value);
      }
      if (errorCodes.size) signals.push(item.signal);
      continue;
    }
    if (item.regex.test(source)) signals.push(item.signal);
  }

  return {
    signals: [...new Set(signals)],
    errorCodes: [...errorCodes],
    relevant: signals.length > 0,
  };
}

function queryFromText(text, detection = detectSignals(text)) {
  const lines = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^["{}[\],]+$/.test(line));

  if (detection.errorCodes.length > 0) return detection.errorCodes[0];
  const diagnostic = lines.filter(line => (
    /failed|failure|error|exception|cannot|unable|not found|报错|失败|异常|找不到|无法/i.test(line) ||
    /hvigor|build-profile|signingConfigs|signature|keyStorePath|签名|编译|打包/i.test(line)
  ));
  const compact = (diagnostic.length ? diagnostic : lines)
    .slice(0, diagnostic.length ? 8 : 12)
    .join(' ');
  return compact.slice(0, 800);
}

module.exports = { detectSignals, queryFromText, SIGNAL_PATTERNS };
