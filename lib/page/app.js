(function () {
  'use strict';

  var DEFAULT_MODE = '__DEFAULT_MODE__';
  var NEEDS_TOKEN = __NEEDS_TOKEN__;
  // 这台设备是**被撤销了**（名册里那条记录被删掉），还是从来没进过门？
  // 由服务端判（它才知道凭据兑不兑得出来），页面只负责把那句话说给用户听。
  var DEVICE_REVOKED = __DEVICE_REVOKED__;
  // 构建指纹，由服务端注入。拼在立绘地址后面，换了图浏览器就不会一直用缓存那张。
  var BUILD = '__BUILD__';
  // 单个文件的大小上限（字节），由服务端注入。页面里不写第二份——两处各写一个数，
  // 迟早会不一致，而那时候的表现是「页面让你传，服务端拒绝」。
  var MAX_UPLOAD = __MAX_UPLOAD__;

  // ---------------- 状态 ----------------
  var params = new URLSearchParams(location.search);
  var state = {
    /**
     * 进没进门——**由服务端说了算**（2026-10-16 第二步）。
     *
     * 服务端只在「没放行」的那一次渲染门禁页（needsToken=true）；放行时永远是 false。
     * 这是页面之后唯一需要的身份信息：真正的凭据是一枚 HttpOnly 的设备 cookie，
     * 页面看不见、也不该管它——浏览器自己会给同源的每一趟请求带上。
     */
    entered: !NEEDS_TOKEN,
    mode: localStorage.getItem('dshMiniMode') || DEFAULT_MODE || 'minimal',
    // 外观：'dark' | 'light' | 'auto'。默认深色——不给老用户换掉现在的样子；
    // 要浅色或跟着系统走，去设置页「外观」点一下。
    theme: localStorage.getItem('dshMiniTheme') || 'light',
    // 字体大小：'small' | 'normal' | 'large'。默认标准。
    fontSize: localStorage.getItem('dshMiniFont') || 'normal',
    sound: localStorage.getItem('dshMiniSound') !== 'off',
    // 锁屏也能提醒（系统通知）。默认关着——它要用户主动点一下才会申请权限，
    // 不能替他决定。明文连接下这一项永远是空转的，见下面「锁屏也能提醒」那一段。
    notify: localStorage.getItem('dshMiniNotify') === 'on',
    /**
     * **流式开关**（2026-10-21，用户要求做成全局切换）：开着时回答正文一个字一个字往外冒，
     * 关着时等整段落定再显示（就是原来的样子）。
     *
     * **2026-11-27 起默认开**：用户实机用了一阵之后拍板「流式改为默认打开」（他那台
     * 早就手动开了）。只认显式的 `off`——存着 'off' 的照旧关着，没存过（新设备、
     * 清过缓存）就是开。想关的人去设置页点一下，那次点击会写 'off' 进来。
     *
     * **单帧模式不跟**（用户拍板）——那一屏就是"只看最终那一句"，流式反而毁掉它。
     * 开关状态存在本机（和主题、字号、声音一样），但它决定的是连上去要不要带 `stream=1`，
     * 所以关掉时服务端连正文帧都不发，是真省流量。
     */
    streaming: localStorage.getItem('dshMiniStreaming') !== 'off',
    /**
     * **鲸鱼娘（立绘）开关**（2026-11-27，用户要求）：**默认关**。
     *
     * 她只在「正在执行」那块露头，是纯装饰（见下面 POSES 那段）。这一屏是遥控器，
     * 默认把地方让给字：只认显式的 'on'，没存过（新设备、清过缓存）就是关。
     * **关掉不等于把整块收掉**：计时和「停止」留着，否则任务中止不了——
     * 实现上和「完整」模式共用 `.work.bare`（见 style.css），只藏装饰。
     */
    pet: localStorage.getItem('dshMiniPet') === 'on',
    /**
     * **本轮已经花了多少 token**（2026-11-27）：服务端 `usage` 帧原样存着，
     * `{ sessionId, turn, step, billed, output, total, estimated }`。
     *
     * 它只喂「正在流」那一块的徽标（见 paintTokens）；落定后的徽标走历史条目里的
     * `usage`（服务端和回答一起存下来的那份），两者不是一回事：这个是估算的、会跳，
     * 那个是精确的、跟着消息走。
     */
    usage: null,
    /**
     * **这一轮是不是真的收到过正文增量**（2026-10-22）。
     *
     * `state.streaming` 只是本机的开关偏好；连接上到底订没订上、帧有没有来，只有收到
     * 正文帧才算数。加这个记号是为了防止一种误伤：开关状态和连接状态短暂不一致时，
     * 一条 `state` 快照会把刚流出来的字按 `snap.live` 抹掉（快照那条是另一套旧机制，
     * 恒为空），用户看到的就是「流了一下，内容消失」。收到过正文帧就以帧为准。
     */
    streamReceived: false,
    /**
     * **正在拼的那个工具调用**（2026-10-21）：`{ name, args }`。
     * 模型一边写参数（JSON），轨迹的组头一边把半截命令/路径顺出来——
     * 和 PC 上「正在调用 bash · ls -la …」那种感觉对齐。
     * 落定（`tool/call` 进轨迹）时清空，由真条目接管。
     */
    liveTool: null,
    running: false,
    subagentsRunning: false,
    sessions: [],
    // 排队中的指令（[{ id, text, placement }]）。跑着任务时接着发的那几条排在这儿，
    // 由服务端每次取快照时从 agent 的收件箱现读，手机不自己记。
    queued: [],
    boundSessionId: null,
    connected: false,
    lastReplyStamp: 0,
    // 传好了、还没发出去的文件（[{ uploadId, name, bytes }]）。
    // 只存服务端发回来的那张小票，不存附件本身——真正的东西已经在电脑上了。
    uploads: [],
    // 正在流出来的那一段。空字符串 = 这会儿没有东西要显示。
    live: '',
    /**
     * 模型此刻的自言自语（鲸鱼娘的台词）：{ text, at } 或 null。
     *
     * **和 live 严格分开**：live 非空时整块 #work 会让位（那是「回答正在往外冒」的
     * 规矩），台词要是塞进 live，会出现「该说话的时候鲸鱼娘不见了」。
     * 它也不进 #reply——2026-09-22 用户否掉的就是「过程的文字跑进回答区」。
     */
    thought: null,
    /**
     * **这一段思考**（2026-11-27，聊天模式要看的那个「思考过程」）。
     *
     * 和上面 `thought` 是两样东西，别混：
     *   · `thought` 是鲸鱼娘的气泡台词（一句旁白，不进 #reply）；
     *   · `thinking` 是模型这段思考本身：`{ detail, text, done, at }`，**要进 #reply**——
     *     流式时贴在最后一条回答的位置上、只露一行摘要；落定后（`done`）变成可展开的定稿。
     * 只留最新这一份：翻旧记录要看的思考，是「它刚才在想什么」，不是历史全量。
     */
    thinking: null,
    /**
     * 已经**落定到某条回答**上的思考：`{ [回答的 timestamp]: { detail, text } }`。
     *
     * 为什么按 timestamp 挂：定稿要贴在「它那一条回答」前面，翻页/重画/切回来都不能错位。
     * 只在最新 8 条上留（见 reply 那条监听里的上限）——翻很旧的历史时没有思考，这是
     * 有意的：服务端重放里没有 reasoning，**不编**。
     */
    thoughts: Object.create(null),
    // 服务端正去读这个会话的完整记录（点开一个插件没看过的会话时会有这一下）。
    historyLoading: false,
    // 「这份历史只到最近一段」（服务端读历史有上限时会给这一句）。
    historyTruncated: false,
    historyNote: '',
    /**
     * 更早的那几段历史（2026-11-27，按需取回来的，见 fetchOlderChat）。
     *
     * 服务端现在只在 `state` 快照里推最近几轮（`historyTurns`），更早的存在这儿：
     * 拼在 `state.history` **前面**用（见 buildChat）。切会话必须清空——两场会话的
     * 时间戳会撞在一起，留着就会把上一个会话的旧记录混进新会话里。
     */
    historyOlder: [],
    /** 上面那一份是哪场会话的（和 historyOlder 同生同死）。 */
    historyOlderFor: null,
    /** 服务端说「前面还有没给的轮」（见 store.js 的 historyHasMore）。 */
    historyHasMore: false,
    /** 这次给到的最早轮号，取更早时当 before 用。 */
    historyOldestTurn: null,
    /** 正在取更早的那一段（防止一次手势连发好几个请求）。 */
    historyFetching: false,
    /**
     * 执行轨迹（「完整」模式里的过程）：一组一轮，形状与服务端
     * `GET /mini/api/trajectory` 的 `turns` 一字不差
     * （`[{ turn, state, reason, entries:[…] }]`）。
     *
     * **它和 latest / history 是两回事**：思考正文只活在 `entries[].output` 里，
     * 回答气泡那两条路（`state.latest` / `state.history`）一个字都不碰它——
     * 这是 2026-09-27 用户定的边界（思维链一个字都不上气泡）。
     *
     * 只在「完整」模式订阅、只在那里画；切回单帧/聊天就退订，不再收也不再画。
     */
    trajectory: [],
    trajectoryNote: '',        // 「这份轨迹不是全部」时服务端给的那句话（展示下一棒接手）
    trajectoryTruncated: false,
    trajectoryLoading: false,  // 服务端还在读会话记录（**不等于「没有过程」**）
    trajectoryEpoch: '',       // 服务换了一代（重启）就不能再往旧的那份上面接
    trajectorySeq: 0,          // 收到第几帧，用来认出「我漏了几帧」（只进不退）
    trajectoryLive: '',        // 活片段：正在想的那一句（只有完整模式有值，落盘即清）
    // 斜杠指令的列表（在输入框里打 / 时弹出来的那个菜单）。
    // **按绑定的会话缓存**：指令表是每个会话一份的，而这个会话没在跑时服务端一条都
    // 读不到（回 ok:false + 一句话）。所以换了会话必须重取——否则用户点到的是上一个
    // 会话的指令，点下去必然被拒，而他从屏幕上完全看不出为什么。
    commands: null,        // null = 还没取到
    commandsError: '',     // 取不到时服务端给的那句话，原样显示给用户
    commandsFor: null,     // 上面这份数据是哪个会话的
    commandsLoading: false, // 正在取（挡住重复请求，见 loadCommands）
    /**
     * 「输入框里这一行曾经是一条指令」——点过面板/菜单里某一条之后，这里记着它的名字。
     *
     * 用来堵一个真缺口：点了一条要参数的指令，用户把 `/名字 ` 里的名字删掉、只留参数，
     * 那一行就不再以 `/` 开头，会被当成普通提问发给模型，白花一次额度。
     * 有这枚标记时，send() 会把这一行拦下来，让他补回名字或**清空输入框**（= 明确取消）。
     */
    pendingCommand: null
  };
  /**
   * 地址里那一枚令牌**只是入场那一下**（2026-10-16 第二步）。
   *
   * 服务端在上面那一次请求里已经把它换成了设备凭据（HttpOnly cookie，浏览器自己带），
   * 页面从此不读它、不存它、也不再往任何请求里放它。这里只做一件事：把地址栏擦干净，
   * 免得被截图/分享带出去。
   */
  if (params.get('token')) history.replaceState(null, '', location.pathname);

  /**
   * ---------------- 执行轨迹：订阅与收帧（数据层） ----------------
   *
   * 轨迹**不走全量快照**：实测它的正文是回答正文的 90.7 倍（单轮最高约 946KB），
   * 而 `event: state` 是「每条广播都发整份」。所以它走单独的增量帧
   * （`event: trajectory`，每帧只带新加的几条和改了的几笔），且**只有「完整」模式的
   * 连接才订**——不看这块的人一个字节都不付。
   *
   * 三件事一起看才完整：切到「完整」时订上并 GET 一次当前状态；切回单帧/聊天就退订；
   * 断线重连把 clientId 和 `?full=1` 带在流地址上（服务端自动重新订上），重连后再
   * GET 一次对齐——帧里的 epoch 变了就整个重拉。
   *
   * 本片到「收进 state.trajectory」为止；画法（三层折叠）在 renderFull 后面那一片。
   * clientId / subscribedClientId 两个连接身份变量声明在下面 SSE 一节里——
   * 那一节被测试整段抠出来跑，身份必须跟流地址待在一起才找得到。
   */

  /**
   * 这一帧该不该接、接到哪一组。三道门：
   * 不是「完整」模式不接（退订之后可能还有在路上的旧帧）；
   * 不是当前这个会话不接（切会话了，旧会话的过程与新会话无关）。
   * 没有这一组就立一个（turn 号是帧给的，组里 entries 往后只增不减）。
   */
  function trajectoryKeyOf(frame) {
    if (state.mode !== 'full') return null;
    if (frame.sessionId && state.boundSessionId && frame.sessionId !== state.boundSessionId) return null;
    var turn = typeof frame.turn === 'number' ? frame.turn : null;
    for (var i = 0; i < state.trajectory.length; i++) {
      if (state.trajectory[i].turn === turn) return state.trajectory[i];
    }
    var group = { turn: turn, state: 'running', reason: null, entries: [] };
    state.trajectory.push(group);
    return group;
  }

  /**
   * 把一条增量补丁贴到已有条目上。**只改补丁里真有的字段**——「停了」那种补丁不该
   * 顺手把输出清空；截断信息是合并而不是替换（一条工具步可能参数超长、结果也超长）。
   * 写法和 lib/trajectory.js 的 applyTrajectoryPatch 一致：两端对同一笔补丁的理解
   * 必须一样，否则手机上会出现「明明有结果却还写着正在跑」。
   */
  function patchTrajectoryEntry(entry, patch) {
    if (!entry || !patch) return;
    if (typeof patch.state === 'string') entry.state = patch.state;
    if (Object.prototype.hasOwnProperty.call(patch, 'output')) entry.output = patch.output;
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) entry.error = patch.error;
    if (patch.truncated) {
      entry.truncated = Object.assign({}, entry.truncated || {}, patch.truncated);
    }
  }

  /**
   * 一帧的落法，四步按顺序走：
   *
   * 1. **换代认新**：帧里 epoch 和手里记的不一样（服务重启过），旧的那份整份作废，
   *    用 GET 重拉——旧代的 seq 在新代里毫无意义，硬拼会出现「凭空多出半截过程」。
   * 2. **缺帧认补**：帧的 seq 比预期大出不止一格，中间丢过帧，GET 重拉；
   *    seq 只进不退（重连后服务端可能从头再发一轮）。
   * 3. **add 幂等**：同一条目按 id 认——收过就改成补丁，没收过才追加。
   *    同一帧送两遍（重连重放）不会长出两份，这是「帧重复」的硬要求。
   * 4. **组态只进结论**：一组的 running 是过程中的默认值，收下任何结论态就不再
   *    被后面的 running 盖回去（结论到了之后又来一条旧的 running 帧，不算输）。
   */
  function applyTrajectoryFrame(frame) {
    if (!frame || typeof frame !== 'object') return false;
    var epoch = typeof frame.epoch === 'string' ? frame.epoch : '';
    if (state.trajectoryEpoch && epoch && epoch !== state.trajectoryEpoch) {
      state.trajectoryEpoch = epoch;
      state.trajectorySeq = 0;
      state.trajectory = [];
      if (state.mode === 'full') requestTrajectory();
      return false;
    }
    if (!state.trajectoryEpoch && epoch) state.trajectoryEpoch = epoch;
    var seq = typeof frame.seq === 'number' ? frame.seq : 0;
    if (seq > 0 && state.trajectorySeq > 0 && seq > state.trajectorySeq + 1) {
      state.trajectorySeq = seq;
      if (state.mode === 'full') requestTrajectory();
      return false;
    }
    if (seq > state.trajectorySeq) state.trajectorySeq = seq;

    var group = trajectoryKeyOf(frame);
    if (!group) return false;

    var add = Array.isArray(frame.add) ? frame.add : [];
    for (var i = 0; i < add.length; i++) {
      var raw = add[i];
      if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
      var hit = null;
      for (var j = 0; j < group.entries.length; j++) {
        if (group.entries[j].id === raw.id) { hit = group.entries[j]; break; }
      }
      if (hit) {
        patchTrajectoryEntry(hit, raw);
      } else {
        group.entries.push({
          id: raw.id,
          turn: typeof raw.turn === 'number' ? raw.turn : group.turn,
          step: raw.step,
          // 三种条目照单全收（think / say / tool）——旁白（say）是 2026-10-04 加的，
          // 这里原来写死成两种，实时帧里的旁白会被画成「工具调用」空壳行，
          // 等下一次整份对齐才变回正文段落（真机上就是「展现不对」）。
          kind: raw.kind === 'think' || raw.kind === 'say' ? raw.kind : 'tool',
          name: raw.name,
          args: raw.args,
          summary: raw.summary,
          output: raw.output,
          state: typeof raw.state === 'string' ? raw.state : 'running',
          error: raw.error || null,
          truncated: raw.truncated || null,
          timestamp: raw.timestamp,
        });
      }
    }
    // 真条目进来了：活片段让位（服务端也会喊清，这里兜一道——影子不许盖住落定的字）。
    if (add.length) {
      state.trajectoryLive = '';
      // **只有 think 条目时不要撤正文**（2026-10-22 真机）：
      // 思考落定不代表回答落定。最终回答那一步通常带 reasoning，落定时会先来一条
      // think 条目；原来这里见 add 就清 `state.live`，屏幕上的正文会先消失一下，
      // 等 reply 到了再整段出现——看起来就是「流了一下，内容没了，然后全文蹦出来」。
      // 旁白（say）和工具（tool）落定时才让位：那两样才是「过程结束了」的信号。
      var onlyThink = true;
      for (var ai = 0; ai < add.length; ai += 1) {
        if (!add[ai] || add[ai].kind !== 'think') { onlyThink = false; break; }
      }
      if (!onlyThink) {
        state.live = '';
        // 工具调用落定了（真条目已经进轨迹）：那半截参数该让位，否则标题行会一直挂着
        // 一条已经执行完的命令。
        state.liveTool = null;
      }
    }
    var upd = Array.isArray(frame.update) ? frame.update : [];
    for (var k = 0; k < upd.length; k++) {
      var patch = upd[k];
      if (!patch || typeof patch.id !== 'string') continue;
      for (var m = 0; m < group.entries.length; m++) {
        if (group.entries[m].id === patch.id) { patchTrajectoryEntry(group.entries[m], patch); break; }
      }
    }
    if (typeof frame.state === 'string' && frame.state !== 'running') {
      group.state = frame.state;
      group.reason = frame.reason || null;
    } else if (group.state === 'running') {
      if (frame.reason) group.reason = frame.reason;
    }
    return true;
  }

  /** 一帧到了：落进手里那份，只在「完整」模式下重画。 */
  function receiveTrajectoryFrame(frame) {
    if (!applyTrajectoryFrame(frame)) return;
    render();
  }

  /**
   * 用一份 GET 结果把手里那份**整个换掉**（不是往里合）：GET 是服务端按当前记录
   * 重新汇总的全量视图，比任何增量拼接都新，换掉就不会「补丁叠在过期底稿上」。
   * `loading` 如实收下——它说的是「还在读会话记录」，不是「没有过程」。
   */
  function setTrajectoryFromGet(view) {
    if (!view || view.ok !== true) return;
    state.trajectoryEpoch = typeof view.epoch === 'string' ? view.epoch : state.trajectoryEpoch;
    state.trajectorySeq = typeof view.seq === 'number' ? view.seq : 0;
    state.trajectory = Array.isArray(view.turns) ? view.turns : [];
    state.trajectoryTruncated = view.truncated === true;
    state.trajectoryNote = typeof view.note === 'string' && view.note ? view.note : '';
    state.trajectoryLoading = view.loading === true;
    render();
  }

  /**
   * 拉一次当前过程。只在「完整」模式发；不是完整模式宁可什么都不说——去要一份
   * 自己没订的数据，等于给服务端添一次白跑。读完只有两种岔路：是完整模式且还是
   * 同一个会话才收下（发请求后切了会话/切了模式，这份就是旧账，直接丢），
   * 读不到就把原因写出来，不说「没有过程」。
   */
  function requestTrajectory() {
    if (state.mode !== 'full' || !state.entered) return;
    var sessionId = state.boundSessionId;
    if (!sessionId) {
      state.trajectory = [];
      state.trajectorySeq = 0;
      state.trajectoryLoading = false;
      return;
    }
    state.trajectoryLoading = true;
    api('/mini/api/trajectory?sessionId=' + encodeURIComponent(sessionId))
      .then(function (view) {
        if (state.mode !== 'full' || state.boundSessionId !== sessionId) return;
        setTrajectoryFromGet(view);
      })
      .catch(function () {
        if (state.mode !== 'full' || state.boundSessionId !== sessionId) return;
        state.trajectoryLoading = false;
        state.trajectoryNote = '读不到这个会话的过程。';
        render();
      });
  }

  /**
   * 正文流式的订阅侧动作：**连接建早了/建晚了，就补一次重连。**
   *
   * 两个真会走到的岔口：
   *   ① 页面在「单帧」里打开（默认），之后切到「聊天 / 完整」——旧连接没带 `stream=1`，
   *      不重连就永远收不到正文帧（2026-10-22 真机复现：开关明明显示「开」，回答仍整段出现）；
   *   ② 开关本来就存着「开」，点它一下不会改值——原来的提前 return 把重连也一起跳过了。
   * 只有「想要的」和「连接上真带的」不一致才重连，避免每点一下都重来。
   */
  function syncStreamSubscription() {
    if (!state.entered) return;
    var want = state.streaming && state.mode !== 'minimal';
    if (want !== streamSubscribed) connect();
  }

  /**
   * 模式开关的订阅侧动作，跟着「显示模式」按钮走：
   *
   * - 切到「完整」：连流时没带 `?full=1`（连流那一刻不是完整模式）就得补一次
   *   POST 订上，然后 GET 一次把手里的换成当前状态；已经订过就只 GET 对齐。
   * - 切走：POST 退订，同时把身份清掉——服务端那条连接已经不再推了，
   *   手里这个「已订」的记号必须同步作废，否则下次切回来会误以为还订着。
   * - POST 回 404：这条流已经不在了（服务重启或断流没重连），立刻重连一次；
   *   重连的地址自带 `?full=1`（当前就是完整模式），服务端会重新把这条连接订上。
   *   重连成功与否都不用在这里补救——`open` 里那一套会再走一遍。
   */
  function syncTrajectorySubscription() {
    if (!state.entered) return;
    var want = state.mode === 'full';
    if (!want) {
      if (subscribedClientId) {
        var was = subscribedClientId;
        subscribedClientId = '';
        api('/mini/api/trajectory/subscribe', {
          method: 'POST',
          body: JSON.stringify({ clientId: was, on: false }),
        }).catch(function () { /* 断了就断了：服务端本来就会随连接清理 */ });
      }
      return;
    }
    if (subscribedClientId) {
      requestTrajectory();
      return;
    }
    api('/mini/api/trajectory/subscribe', {
      method: 'POST',
      body: JSON.stringify({ clientId: clientId, on: true }),
    }).then(function () {
      if (state.mode !== 'full') return; // 刚要订又切走了，回包当没看见
      subscribedClientId = clientId;
      requestTrajectory();
    }).catch(function (err) {
      if (err && err.status === 404) connect();
    });
  }

  var $ = function (id) { return document.getElementById(id); };
  var mainEl = $('main'), replyEl = $('reply'), inputEl = $('input');
  var dotEl = $('dot'), statusEl = $('status');

  // ---------------- 小工具 ----------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // 复制按钮的两个图标。做成常量而不是散在各处：以后换图标只改这一处。
  // 形状（两个重叠的方框）和配色都在 CSS 的 .copy 里，这里只管画线。
  var ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<rect x="5.6" y="1.6" width="8.8" height="8.8" rx="2.2"/>'
    + '<rect x="1.6" y="5.6" width="8.8" height="8.8" rx="2.2"/></svg>';
  var ICON_DONE = '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M2.6 8.4l3.6 3.6 7.2-7.2"/></svg>';
  function linkify(text) {
    return escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
  }

  // ---------------- Markdown 渲染 ----------------
  // 手写的最小实现，不引依赖（这个页面是单文件、免构建的）。
  //
  // 顺序不能换：**先转义，再上标签**。模型吐出来的东西一律当纯文本，
  // 只把它写成的那几种语法变成 HTML——绝不让原文里的标签生效。
  // 认不出来的语法原样留着：宁可少渲染，不能吃掉内容。
  var CODE_SLOT = '\u0000';

  /**
   * 正文里的图片地址 → 真正去取的地址。三种写法见下面 mdInline 那段注释。
   *
   * 判据只有一条：**不是 http(s) 就走同源**。所以 `javascript:`、`data:` 这类
   * 永远不会出现在 src 里；认不出的地址最多是取回来 404，不会变成别的东西。
   *
   * 放在这里而不是立绘那一段（artUrl 旁边）：页面测试是从 escapeHtml 抠到复制按钮
   * 那一小段的，放外面就测不到真代码了。
   */
  function imageSrc(src) {
    if (/^https?:\/\//i.test(src)) return src;
    var name = src.replace(/\\/g, '/').replace(/^\.\//, '');
    if (/^lib\/art\//i.test(name)) name = name.slice(8);
    if (/^[a-z0-9-]+(\.webp)?$/i.test(name)) return artUrl(name.replace(/(\.webp)?$/i, ''));
    // **不拼令牌**：这条路和别的接口一样，靠浏览器自动带上的设备 cookie 认人。
    return '/mini/art/?p=' + encodeURIComponent(src);
  }

  /** 一条图片的名字：路径最后一段（去掉 query / 反斜杠），取不到就叫「图片」。 */
  function imageName(src) {
    var name = String(src || '').replace(/\\/g, '/').replace(/[?#].*$/, '');
    name = name.slice(name.lastIndexOf('/') + 1);
    return name || '图片';
  }

  /**
   * 正文里的一张图（2026-11-27 v2）：**不内联摊开**，画成一条 40×40 缩略图 + 文件名，
   * 点开走全屏查看器（见 ivOpen）。服务端只发 PNG/JPG/WEBP/GIF 且 ≤20MB（见 page.js 的
   * readImage），这里只负责长相。
   */
  function imgRowHtml(src, alt) {
    var url = imageSrc(src);
    var name = imageName(src);
    return '<button class="img-row" type="button" data-img="' + url + '"'
      + ' data-name="' + escapeHtml(name) + '" aria-label="查看图片：' + escapeHtml(name) + '">'
      + '<span class="img-thumb"><img class="md-img" src="' + url + '" alt="' + alt + '"'
      + ' loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>'
      + '<span class="img-name">' + escapeHtml(name) + '</span>'
      + '<span class="img-open">查看</span></button>';
  }

  function mdInline(raw) {
    // 行内代码先挖出来换成占位符。不这么做的话，`**x**` 这种字面量
    // 会被后面的粗体规则吃掉，代码里写的东西就显示错了。
    var codes = [];
    var out = escapeHtml(raw).replace(/`([^`]+)`/g, function (_, code) {
      codes.push(code);
      return CODE_SLOT + (codes.length - 1) + CODE_SLOT;
    });
    out = out
      // 图片：![说明](地址)。地址三种写法，判断在 imageSrc 里——
      //   ① 完整 http(s) 链接：原样用，手机直接去那个网站取图；
      //   ② 一个名字（如 out-demo，`.webp` 可带可不带）：走立绘通道 /mini/art/<名字>.webp，
      //      只认 lib/art/ 下「小写字母数字连字符 + .webp」的文件名；写成
      //      `lib/art/out-demo.webp` 这样带前缀的也认（2026-09-28 助手这么写过，手机上成了破图标）；
      //   ③ 电脑上一张图的位置（绝对路径，或相对项目根）：走 /mini/art/?p=…，PNG/JPG/WEBP/GIF 都行，
      //      不要求先拷进 lib/art。
      // 三者之外的一律按 ③ 拼成同源路径，所以 `javascript:`、`data:` 这类进不了 src。
      // 必须排在下面那条链接规则前面：否则 `![x](y)` 里的 `[x](y)` 会先被链接规则
      // 吃掉，只剩下一个光秃秃的感叹号。
      //
      // 2026-11-27 v2：① `<…>` 包裹的地址也认（CommonMark 的写法，路径里有空格时
      // 只能这么写——之前不认，正文里贴的本机截图就成了破图标）。注意这一行跑在
      // `escapeHtml` **之后**，所以尖括号已经变成 `&lt;…&gt;`，两种形态都要匹配；
      // ② 画成一条，不再内联。
      .replace(/!\[([^\]]*)\]\((?:&lt;([^&]+?)&gt;|<([^>]+)>|([^)\s]+))\)/g,
        function (_, alt, esc, raw, bare) {
          return imgRowHtml(esc || raw || bare, alt);
        })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return out.replace(new RegExp(CODE_SLOT + '(\\d+)' + CODE_SLOT, 'g'), function (_, i) {
      return '<code>' + codes[+i] + '</code>';
    });
  }

  function codeBlock(raw, lang) {
    // data-copy 里放转义后的原文，读回来时浏览器会自动还原成原始字符。
    var attr = escapeHtml(raw);
    return '<div class="code"><div class="code-head">'
      + (lang ? '<span class="lang">' + escapeHtml(lang) + '</span>' : '<span></span>')
      + '<button class="copy" type="button" aria-label="复制代码" title="复制代码"'
      + ' data-copy="' + attr + '">' + ICON_COPY + '</button></div>'
      + '<pre><code>' + attr + '</code></pre></div>';
  }

  function isBlockStart(line) {
    return /^\s*```/.test(line)
      || /^\s*#{1,6}\s/.test(line)
      || /^\s*[-*+]\s/.test(line)
      || /^\s*\d+[.)]\s/.test(line)
      || /^\s*>/.test(line)
      || /^\s*\|/.test(line)
      || /^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line);
  }

  function mdToHtml(src) {
    var lines = String(src).split('\n');
    var html = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块：内容只转义，不走行内规则
      var fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        var buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1;
        html.push(codeBlock(buf.join('\n'), fence[1]));
        continue;
      }

      if (!line.trim()) { i += 1; continue; }

      var h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        var n = h[1].length;
        html.push('<h' + n + '>' + mdInline(h[2]) + '</h' + n + '>');
        i += 1;
        continue;
      }

      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { html.push('<hr>'); i += 1; continue; }

      if (/^\s*[-*+]\s+/.test(line)) {
        var ul = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          ul.push('<li>' + mdInline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>');
          i += 1;
        }
        html.push('<ul>' + ul.join('') + '</ul>');
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        var ol = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          ol.push('<li>' + mdInline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>');
          i += 1;
        }
        html.push('<ol>' + ol.join('') + '</ol>');
        continue;
      }

      if (/^\s*>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        html.push('<blockquote>' + mdToHtml(quote.join('\n')) + '</blockquote>');
        continue;
      }

      // 表格：当前行是 | … |，下一行是 |---|---| 这种分隔行
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        var cells = function (l) {
          return l.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
        };
        var head = cells(line);
        i += 2;
        var body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i += 1; }
        html.push('<table><thead><tr>'
          + head.map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('')
          + '</tr></thead><tbody>'
          + body.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>';
          }).join('')
          + '</tbody></table>');
        continue;
      }

      // 段落：连续的非空、非块起始行合成一段
      var para = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { para.push(lines[i]); i += 1; }
      html.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
    }
    return html.join('');
  }

  // 复制。navigator.clipboard 要求安全上下文（HTTPS），手机走局域网明文 HTTP 时
  // 它是 undefined——所以必须有 execCommand 这条退路，否则按钮点下去毫无反应。
  function copyText(text, btn) {
    // 点一下换成对勾，过 1.4 秒自己变回来。
    // 连点的时候要 clearTimeout：不然后一个定时器会被前一个提前触发，
    // 图标在对勾和复制之间闪，或者干脆卡在对勾上不回来。
    var done = function () {
      if (!btn) return;
      btn.classList.add('done');
      btn.innerHTML = ICON_DONE;
      clearTimeout(btn._doneTimer);
      btn._doneTimer = setTimeout(function () {
        btn.classList.remove('done');
        btn.innerHTML = ICON_COPY;
      }, 1400);
    };
    var fallback = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('复制不了，长按选中文字手动复制');
      } catch (err) {
        toast('复制不了，长按选中文字手动复制');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }
  function timeLabel(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  var toastTimer;
  /**
   * 图片没加载出来时要说一声。
   *
   * 手机页认三种图片地址：完整的 http(s) 网址、一个裸名字（页面拼成 /mini/art/<名字>.webp），
   * 或者一张图在电脑上的路径（绝对路径或相对项目根）。三种都认不出来、或者那个文件根本不在，
   * 浏览器只会画一个破图标——用户看到的是"图没了"，却不知道原因（2026-09-28 他为此来过三次）。
   *
   * 为什么挂**捕获**阶段：图片的 error 事件不冒泡，挂冒泡阶段一个也收不到。
   */
  document.addEventListener('error', function (e) {
    var el = e.target
    if (!el || el.tagName !== 'IMG' || !el.classList || !el.classList.contains('md-img')) return
    el.classList.add('md-img-bad')
    // 图片条上那颗缩略图挂了：整条标成坏的，别让用户点开一个空框（见 .img-row.bad）。
    var row = el.closest ? el.closest('.img-row') : null
    if (row && row.classList) row.classList.add('bad')
    toast('这张图手机看不到：那个位置没有这张图，或者它不是 PNG/JPG/WEBP/GIF')
  }, true)

  // ---------------- 全屏看图（2026-11-27 v2） ----------------
  /**
   * 一张图点了「查看」之后的那一层。手势三条：
   *   · 双指捏合 → 缩放（1×–6×）；
   *   · 双击 → 1× ↔ 2.5×；放大后单指拖动平移；
   *   · 下滑（没放大时）或右上角 ✕ 或 Esc → 关掉。
   *
   * 为什么自己写而不是让浏览器整页缩放：整页缩放会把顶栏、输入框一起放大，
   * 用完还得再缩回去，比看不了还烦。这里只动那张图。
   */
  var iv = {
    scale: 1, x: 0, y: 0, pointers: {}, baseDist: 0, baseScale: 1,
    startX: 0, startY: 0, tapAt: 0, tapX: 0, tapY: 0, moved: false,
  };

  function ivApply() {
    var img = $('ivImg')
    if (!img) return
    img.style.transform = 'translate(' + iv.x + 'px,' + iv.y + 'px) scale(' + iv.scale + ')'
    var stage = $('ivStage')
    if (stage) stage.style.cursor = iv.scale > 1 ? 'grab' : 'zoom-in'
  }

  /** 平移只在放大后有意义；边界按舞台大小把图按在里面，别让用户把图甩出屏幕。 */
  function ivPan(x, y) {
    var stage = $('ivStage')
    if (!stage) return
    var maxX = Math.max(0, (stage.clientWidth * (iv.scale - 1)) / 2)
    var maxY = Math.max(0, (stage.clientHeight * (iv.scale - 1)) / 2)
    iv.x = Math.min(maxX, Math.max(-maxX, x))
    iv.y = Math.min(maxY, Math.max(-maxY, y))
  }

  function ivZoom(next) {
    var s = Math.min(6, Math.max(1, next))
    iv.scale = s
    if (s === 1) { iv.x = 0; iv.y = 0 } else ivPan(iv.x, iv.y)
    ivApply()
  }

  function ivOpen(src, name) {
    var box = $('imgView')
    if (!box || !src) return
    $('ivName').textContent = name || '图片'
    var img = $('ivImg')
    img.src = src
    iv.scale = 1; iv.x = 0; iv.y = 0; iv.pointers = {}
    ivApply()
    box.classList.add('open')
    box.setAttribute('aria-hidden', 'false')
    // 背景（聊天记录）别跟着滚：手指一划就滑到别的消息上了。
    document.body.style.overflow = 'hidden'
  }

  function ivClose() {
    var box = $('imgView')
    if (!box || !box.classList.contains('open')) return
    box.classList.remove('open')
    box.setAttribute('aria-hidden', 'true')
    document.body.style.overflow = ''
    var img = $('ivImg')
    if (img) img.removeAttribute('src')
    iv.scale = 1; iv.x = 0; iv.y = 0; iv.pointers = {}
  }

  (function bindImageView() {
    var box = $('imgView')
    var stage = $('ivStage')
    if (!box || !stage) return
    $('ivClose').addEventListener('click', ivClose)
    stage.addEventListener('pointerdown', function (e) {
      iv.pointers[e.pointerId] = { x: e.clientX, y: e.clientY }
      iv.startX = e.clientX; iv.startY = e.clientY; iv.moved = false
      if (Object.keys(iv.pointers).length === 2) {
        iv.baseDist = ivDistance(); iv.baseScale = iv.scale
      }
      if (stage.setPointerCapture) {
        try { stage.setPointerCapture(e.pointerId) } catch (err) { /* 老浏览器没有，忽略 */ }
      }
    })
    stage.addEventListener('pointermove', function (e) {
      var p = iv.pointers[e.pointerId]
      if (!p) return
      var dx = e.clientX - p.x
      var dy = e.clientY - p.y
      if (Math.abs(e.clientX - iv.startX) > 6 || Math.abs(e.clientY - iv.startY) > 6) iv.moved = true
      p.x = e.clientX; p.y = e.clientY
      if (Object.keys(iv.pointers).length >= 2) {
        var d = ivDistance()
        if (iv.baseDist > 0) ivZoom(iv.baseScale * (d / iv.baseDist))
      } else if (iv.scale > 1) {
        ivPan(iv.x + dx, iv.y + dy)
        ivApply()
      }
    })
    function up(e) {
      var had = iv.pointers[e.pointerId]
      delete iv.pointers[e.pointerId]
      var left = Object.keys(iv.pointers).length
      if (left === 1) { iv.baseDist = 0; return }
      if (left > 1 || !had || iv.moved) return
      // 单指轻点：两次挨得近就是双击（放大 / 还原），否则记下这一次的位置与时刻。
      var now = Date.now()
      if (now - iv.tapAt < 320 && Math.abs(e.clientX - iv.tapX) < 30 && Math.abs(e.clientY - iv.tapY) < 30) {
        ivZoom(iv.scale > 1 ? 1 : 2.5)
        iv.tapAt = 0
      } else {
        iv.tapAt = now; iv.tapX = e.clientX; iv.tapY = e.clientY
      }
    }
    stage.addEventListener('pointerup', up)
    stage.addEventListener('pointercancel', up)
    stage.addEventListener('click', function (e) {
      // 点背景关（放大时点了多半是想拖，别误关）
      if (e.target === stage && iv.scale === 1) ivClose()
    })
    stage.addEventListener('wheel', function (e) {
      if (!box.classList.contains('open')) return
      e.preventDefault()
      ivZoom(iv.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2))
    }, { passive: false })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') ivClose()
    })
  })()

  /** 两根手指之间的距离（单指时是 0）。 */
  function ivDistance() {
    var ids = Object.keys(iv.pointers)
    if (ids.length < 2) return 0
    var a = iv.pointers[ids[0]]
    var b = iv.pointers[ids[1]]
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))
  }

  // 点任何一条图片条（正文、子智能体文档、提问卡里都可能出现）都走同一个查看器。
  document.addEventListener('click', function (e) {
    var row = e.target && e.target.closest ? e.target.closest('.img-row') : null
    if (!row) return
    e.preventDefault()
    ivOpen(row.getAttribute('data-img'), row.getAttribute('data-name'))
  })

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    // 普通提示**一定是纯字**：上一版如果带着「撤销」那颗按钮，这里要把它连同
    // with-act 一起收掉，否则会留下一个按了没反应的按钮（它的回调早就过期了）。
    el.classList.remove('with-act');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  /**
   * 带一个动作的提示。目前只有一处用：归档成功后的「撤销」。
   *
   * 为什么单独一个函数、而不是给 toast 加参数：普通提示是**纯字、点不中**的
   * （见 #toast 的 pointer-events），带动作就得反过来——两种形状差别够大，
   * 混在一个函数里迟早会让某一条普通提示也莫名其妙能点。
   *
   * 停留 6 秒：短于这个数，用户看到"归档了"再去找按钮就已经没了；长于这个数，
   * 它会一直压着输入区上方那块地方。
   */
  function toastAction(msg, label, onTap) {
    var el = $('toast');
    el.textContent = '';
    var text = document.createElement('span');
    text.textContent = msg;
    el.appendChild(text);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-act';
    btn.textContent = label;
    btn.addEventListener('click', function () {
      el.classList.remove('show');
      el.classList.remove('with-act');
      clearTimeout(toastTimer);
      onTap();
    });
    el.appendChild(btn);
    el.classList.add('with-act');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
      // 收掉的时候把 with-act 一起收：光藏起来的话，那层透明的提示仍然接着点击。
      setTimeout(function () { el.classList.remove('with-act'); }, 220);
    }, 6000);
  }
  /**
   * 每一趟请求带什么头。
   *
   * **一个凭据都不带**（2026-10-16 第二步）：进门那一下服务端已经把身份换成了设备 cookie
   * （HttpOnly），浏览器自己会给同源的每一趟请求带上它——请求头和地址里从此不再出现令牌。
   * 这也是「名册里删掉那条记录 = 那台设备当场什么都做不了」能成立的前提。
   */
  function authHeaders(isJson) {
    return isJson === false ? {} : { 'Content-Type': 'application/json' };
  }
  function api(path, options) {
    var opts = options || {};
    // 传文件的时候**不能**写 Content-Type: application/json——那是给 JSON 用的。
    // 硬写上去，服务端收到的就是一个错的文件类型声明，而浏览器也没机会自己定。
    var raw = typeof Blob !== 'undefined' && (opts.body instanceof Blob
      || (typeof FormData !== 'undefined' && opts.body instanceof FormData));
    opts.headers = Object.assign(authHeaders(!raw), opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) {
          var err = new Error(body.error || ('HTTP ' + r.status));
          // 状态码挂在错上带出去：调用方要区分「服务端说这题已经结束了」（409）和
          // 「压根没连上」（fetch 直接抛）——靠中文字面去猜太脆。
          err.status = r.status;
          // 整个响应体也挂上。归档那条要**读里面的 activity**（会停掉哪些工作）才能
          // 弹确认框——只靠状态码看不出"还有工作在跑"和"工作区服务拿不到"的区别。
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  // ---------------- 声音与震动 ----------------
  var audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      // 播放一个静音脉冲，iOS 要求真正出过声才算解锁。
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      g.gain.value = 0;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.01);
    } catch (e) { /* 不支持就算了，不影响主流程 */ }
  }
  function playDing() {
    if (!state.sound || !audioCtx || audioCtx.state !== 'running') return;
    try {
      var t = audioCtx.currentTime;
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, t);
      o.frequency.setValueAtTime(1180, t + 0.11);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.36);
    } catch (e) { /* 忽略 */ }
  }
  function buzz() {
    if (state.sound && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }

  // ---------------- 「正在执行」的鲸鱼娘 ----------------
  // 这些姿态是**装饰性**的：插件按设计只收「用户指令 + 最终回复」，拿不到 Agent
  // 此刻在干什么，所以轮播不是进度播报，只是让等待有点人味。
  // 气泡里的话也守着这条线——说的是「还在忙」，不谎报「已完成 60%」。
  //
  // **还有一条更硬的规矩：不许报忧。** 用户正在等结果，这时候冒出「出错了」
  // 「不对劲」之类的话，他会当真。可这些话跟 Agent 实际状态毫无关系，纯粹是
  // 轮到第几张图。原来第 4 条写的「这里有点不对劲」就是这么个东西，2026-09-22
  // 被用户指着问「这一句有问题还是什么」，已改掉。测试钉着这条：见 page.test.mjs
  // 的「鲸鱼娘说的话里不许出现让人以为出事的字眼」。
  //
  // 每个姿势是一张「并排若干帧」的雪碧图，flip 是**走完一整圈翻帧**的秒数
  // （代码里它就是 animation-duration：两帧时每帧占 flip/2，六帧时每帧占 flip/6）：
  // 敲键盘和小跑要快，端着茶等和托腮想事情要慢。节奏跟着动作走，才不像机器在闪。
  var POSES = [
    { file: 'work-1-ready', line: '收到，这就去办', flip: 0.5 },
    { file: 'work-2-reading', line: '先翻翻资料', flip: 1.5 },
    { file: 'work-3-typing', line: '正在写…', flip: 0.34 },
    // 这一句原来是「这里有点不对劲」。**那是错的，而且是有害的**：轮播是装饰性的，
    // 轮到哪张图跟 Agent 实际在干什么毫无关系，可用户正在等结果，看到手机上写
    // 「不对劲」只会以为出事了。用户 2026-09-22 实机指着这条问「这一句有问题还是
    // 什么」，并指定改成「让我检查检查」——姿态叫 checking（核对），这句正好相称：
    // 只说自己在看，不下判断。
    { file: 'work-4-checking', line: '让我检查检查', flip: 1.2 },
    { file: 'work-5-thinking', line: '嗯…让我想想', flip: 1.7 },
    // 跑从 2026-09-28 起是 6 帧：先把两帧画出来的头发摆动收小（甩幅 155.3 → 70.6），
    // 再用 tools/whale-sway.py 把这一趟切成六帧（甩幅 74.9），身体逐像素不动。
    // 时长仍是 flip 秒、不乘帧数，所以腿脚换帧的快慢和两帧时一模一样，六帧只是把头发那一趟切得更细。
    { file: 'work-6-running', line: '跑一遍看看', flip: 0.4, frames: 6 },
    // 用户 2026-09-22 要的「跑步的动作」。它**不是第 8 个姿势，而是姿势之间的过渡**：
    // 序列是「姿势1 → 冲刺 → 姿势2 → 冲刺 → …」，表达「她干完一件、跑去干下一件」。
    // 所以它带 gap: true——不进轮播循环，只在每个姿势后面闪一下。
    // **停留时长改过一次方向**：原本刻意比姿势短（怕它「成了又一个姿势」），
    // 但用户两次要求拉长，现在 GAP_MS 和 POSE_MS 一样是 3.6 秒。理由见 GAP_MS 的注释。
    // 它和上面那张小跑**刻意画得不一样**：侧面视角、身体前倾、步子拉得更开。
    // **不带词条**（line 是空串）——用户指定的，冲刺是纯动作，硬配一句话反而弱。
    // 文件名里的 8 只是个名字，**顺序由数组决定**，别拿它当序号。 */
    // **帧数 6（2026-09-29）**：原来只有 2 帧，头发只能整个姿势硬切过去。2 帧的摆动
    // 没法"流畅"——两帧之间没有中间态。现在这 6 帧的头发是拿冻结基准帧当底、
    // 用位移场程序化算出来的（tools/whale-sway.py），身体逐像素不动：
    // 越靠发梢摆得越大、相位越滞后，采样一个周期得到 6 帧。摆幅默认 15 像素、
    // 相位滞后 300°，量出来的甩幅 128.9（用户给的目标区间 110~140）。
    // **它只解决头发**：身体和腿仍然是那两帧，跑起来腿脚还是瞬间换的。
    { file: 'work-8-sprinting', line: '', flip: 0.28, gap: true, frames: 6 },
    // 最后一个只在任务真的跑够久了才进轮播——到那时候说这句话才是实话。
    // **它必须留在最后**：posePool 用的是 POSES.length - 1，靠位置认它。
    { file: 'work-7-waiting', line: '还在忙，再等我一会儿', flip: 2.0 }
  ];
  var POSE_MS = 3600;
  /** 冲刺那张停多久。
   *
   *  用户同一天提了两次，方向一致：2026-09-22 上午「间隙跑步动画的持续时间太短了」，
   *  从 1.4 秒拉到 2.4 秒；同日下午又说「出现时间可以再久一些」，再拉到 3.6 秒，
   *  **和一个正常姿势一样长**。
   *
   *  原先这里写着「过渡就该快，跟姿势一样长的话它就成了又一个姿势」——那个顾虑
   *  被用户两次要求推翻了：他要的就是看清这个动作，而 2.4 秒（约 8 个跑步循环）
   *  看着还是「一闪而过」。既然他愿意为它多等，就别再按「过渡」对待它。
   *  代价是整圈轮播从 48 秒变 57.6 秒，「还在忙」那张（SLOW_MS = 60 秒）会在
   *  第二圈开头才轮得到——比原来晚十几秒，可接受。
   *
   *  再要调就调这一个数，别再动 flip：那是跑步循环的快慢，跟停留时长是两回事。 */
  var GAP_MS = 3600;
  var SLOW_MS = 60000;

  /**
   * 说话那张立绘。**它不进 POSES。**
   *
   * POSES 是轮播的节目单，进去就要占一格（还要连带改 posePool 那套按位置认「还在忙」
   * 的写法）。这张是**按需插播**的：只在宿主侧推来台词时出现，说完就回原来的顺序。
   * 文件名里的 9 同样只是个名字，跟顺序无关。
   */
  var SPEAK_POSE = { file: 'work-9-talking', flip: 1.1 };
  /**
   * 一句台词占多久：**按字数算**，短的有起步时长，长的封顶。
   *
   * 用户 2026-09-26 选的是「一直说到它结束（最多 10 秒）」；2026-09-27 他觉得太短，
   * 问能不能再久一点。原来是一律 10 秒——短句够用，可长句在 2026-09-27 起会**完整显示**
   * （不再截断），一句 200 字的话念 10 秒根本念不完，她就已经回去干别的了。
   *
   * 所以：起步 15 秒，每多一个字多留 0.15 秒（≈ 一分钟 400 字，手机上舒服的默读速度），
   * 30 秒封顶——封顶是为了防「某一轮她再没说话、画面却一直卡在说话那张」。
   * 宿主侧只拿得到**整段**（一步一步来的，不是逐字），所以「结束」得自己收尾：
   * 下一句台词来了就把表往后推，一直没有新的或这一轮结束了，就到点放回轮播。
   */
  var SPEAK_MIN_MS = 15000;
  var SPEAK_PER_CHAR_MS = 150;
  var SPEAK_MAX_MS = 30000;

  /** 这句话该占多久（见上面三条）。 */
  function speakDuration(text) {
    var n = String(text || '').length;
    return Math.min(SPEAK_MAX_MS, Math.max(SPEAK_MIN_MS, n * SPEAK_PER_CHAR_MS));
  }

  var reducedMotion = false;
  try { reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  var work = {
    startedAt: 0, pose: 0, poseTimer: null, tickTimer: null, layers: [],
    // 说话那张立绘单独一层（不在 POSES 里，见 SPEAK_POSE）。
    speakLayer: null,
    // 正在说的那句台词，以及它最晚说到什么时候。
    speakText: '',
    speakUntil: 0,
    // 已经念过的那句话的身份（宿主侧的 at）。快照来得很密，不认这个的话
    // 同一句话会被反复「重新开始说」，动画一直从头播。
    speakAt: null,
  };

  /** 现在该用哪几条姿态：跑够一分钟才把「还在忙」放进来。 */
  function posePool() {
    return Date.now() - work.startedAt >= SLOW_MS ? POSES.length : POSES.length - 1;
  }

  /**
   * 轮播的完整顺序：**每个姿势之间插一次冲刺**。
   *
   *   姿势1 → 冲刺 → 姿势2 → 冲刺 → 姿势3 → …
   *
   * 用户 2026-09-22 要的效果是「她在干活」：一个姿势带着词条出场，
   * 然后跑动的她横穿过去，再出现下一个姿势。所以冲刺（带 gap 的那些）
   * 自己不进这个循环——它只在间隙里出现，而且每次姿势后面都跟一次。
   *
   * 返回的是 POSES 的下标序列，长度随「跑了多久」变（前 60 秒不含「还在忙」）。
   */
  function poseSequence() {
    var n = posePool();
    var gaps = [];
    for (var g = 0; g < POSES.length; g += 1) {
      if (POSES[g].gap) gaps.push(g);
    }
    var out = [];
    for (var i = 0; i < n; i += 1) {
      if (POSES[i].gap) continue;
      out.push(i);
      for (var k = 0; k < gaps.length; k += 1) out.push(gaps[k]);
    }
    return out;
  }

  /**
   * 立绘地址。**不带令牌**（2026-10-16 第二步）：进门之后浏览器手里有设备 cookie，
   * 同源的 <img> 自己会带上它。指纹照旧——换了图浏览器不会一直用缓存那张。
   */
  function artUrl(file) {
    return '/mini/art/' + file + '.webp?v=' + encodeURIComponent(BUILD);
  }

  /**
   * 把一句话写进气泡。
   *
   * 走的是和回答区同一个行内渲染（`mdInline`，见上面那段 Markdown 渲染）。它的顺序是
   * **先转义、再上标签**：模型原话里的尖括号仍然只是字面上的尖括号，不会被当成标签；
   * 只有它自己写的 `**粗体**`、`` `代码` ``、链接才会变成样式。留一个口子给"以后不加"。
   *
   * 之前这里是 `textContent`（一句纯文本），于是 `**重启把连接掐断**` 连星号一起端到了
   * 用户面前（2026-09-27 用户报的）。词条那几种是我们自己写的、不含 markdown，也一起走
   * 这个入口——两条路各写各的，早晚会分叉。
   */
  function paintBubble(line) {
    var text = line || '';
    $('workBubble').hidden = !text;
    $('workBubble').innerHTML = mdInline(text);
  }

  function paintPose(index) {
    for (var i = 0; i < work.layers.length; i += 1) {
      work.layers[i].classList.toggle('on', i === index);
    }
    // 轮播回来时把说话那张收掉——它在 POSES 之外，不归上面那个循环管。
    if (work.speakLayer) work.speakLayer.classList.toggle('on', false);
    // 有的姿势不带词条（比如那张冲刺）：词条是空串就把整个气泡收起来。
    // 留一个空泡泡在那儿比不放气泡更怪——那个尖角还指着她的头，像话没说出来。
    // 收起气泡不会让立绘挪位：.work-top 有 min-width 兜着，行宽不变。
    paintBubble(POSES[index].line);
  }

  /**
   * 换成说话那张，把台词写进气泡。
   *
   * 台词是**模型的原话**（宿主机只从旁白里取，模型自己想的那些不上手机），
   * 所以这里只做一件事：原样写出来，不加不减——渲染的那一步交给 `paintBubble`。
   */
  function paintSpeak(text) {
    paintBubble(text);
    // 说话那张没加载出来时（预热那次报错翻过这个开关）：台词照说，**但不动图层**——
    // 把正常那几张全关掉、换上一张空的，她会当场从屏幕上消失（2026-09-27 立的闸）。
    if (work.speakReady === false) return;
    for (var i = 0; i < work.layers.length; i += 1) work.layers[i].classList.toggle('on', false);
    if (work.speakLayer) work.speakLayer.classList.toggle('on', true);
  }

  /**
   * 宿主侧送来的新台词要不要现在就说。
   *
   * 判据是 at（那句话的身份）：**同一句只说一次**。快照广播来得很密，每来一条就重说
   * 一遍的话，说话这张立绘会一直从头播，看着像卡住不动。
   */
  function maybeSpeak() {
    var t = state.thought;
    if (!t || !t.text) {
      // **台词作废了就一起收掉气泡**（2026-11-27 晚，用户：「气泡一直留着不合理，
      // 下次气泡出现替换，回答结束就消失」）。服务端在 turn/end 会把 thought 清空并推一份，
      // 这里不跟着收的话，她下次出现时会把上一轮那句再念一遍。
      if (work.speakAt) {
        work.speakAt = 0;
        work.speakText = '';
        paintBubble('');
      }
      return;
    }
    if (t.at === work.speakAt) return;
    work.speakAt = t.at;
    work.speakText = t.text;
    // 每来一句新的就从这一刻重新算：时长按这句话有多长来（见 speakDuration）。
    work.speakUntil = Date.now() + speakDuration(t.text);
    paintSpeak(t.text);
  }

  function elapsedLabel(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return '已 ' + s + ' 秒';
    return '已 ' + Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  function tickElapsed() {
    $('workElapsed').textContent = elapsedLabel(Date.now() - work.startedAt);
  }

  /**
   * 立绘全部建层并预热——不然第一次「正在执行」会闪一下空白。
   *
   * **2026-11-27 起「鲸鱼娘」默认关着就不拉了**：九张图约 0.8 MB，开着的人少，
   * 不该让每个人一进页面先下这批图。设置里打开的那一刻再调这里（见 segPet 的点击）。
   * 建过就不再重来：开关来回点两下不该把图层叠两遍。
   */
  function preloadPoses() {
    if (work.layers.length) return;
    var stage = $('workStage');
    stage.innerHTML = '';
    work.layers = [];
    for (var i = 0; i < POSES.length; i += 1) {
      var layer = document.createElement('div');
      layer.className = 'pose';
      // 帧数决定显示宽度和用哪套关键帧（CSS 里 2 帧是默认，6 帧挂在 [data-frames="6"]）。
      // **时长不跟着帧数放大**：一圈还是 flip 秒，这样腿脚换帧的快慢跟以前一样。
      layer.setAttribute('data-frames', POSES[i].frames || 2);
      layer.style.backgroundImage = 'url("' + artUrl(POSES[i].file) + '")';
      layer.style.animationDuration = POSES[i].flip + 's';
      stage.appendChild(layer);
      work.layers.push(layer);
      // #work 是 hidden（display:none），浏览器**不会**为它下载背景图。
      // 所以这里得拿一个游离的 <img> 主动拉一次，否则第一次「正在执行」会先闪空白。
      var warm = document.createElement('img');
      warm.src = artUrl(POSES[i].file);
    }
    // 说话那张一起建好、一起预热：等台词来了再新建图层，会说第一个字之前先闪一下空白。
    var speak = document.createElement('div');
    speak.className = 'pose';
    speak.setAttribute('data-frames', SPEAK_POSE.frames || 2);
    speak.style.backgroundImage = 'url("' + artUrl(SPEAK_POSE.file) + '")';
    speak.style.animationDuration = SPEAK_POSE.flip + 's';
    stage.appendChild(speak);
    work.speakLayer = speak;
    var warmSpeak = document.createElement('img');
    // 说话那张要是加载不出来（图还没画好、或者网络半路断了）：**别把舞台清空**。
    // 默认按「图在」处理，只有真报错才翻成 false——正常路径一个字都不变；
    // 翻成 false 之后就退成「台词照说、人照轮播」，而不是她整个消失（见 paintSpeak）。
    warmSpeak.onerror = function () { work.speakReady = false; };
    warmSpeak.src = artUrl(SPEAK_POSE.file);
    paintPose(0);
  }

  /**
   * 轮播往前走一步，然后按**这一步是什么**决定下次隔多久。
   *
   * 原来是一个固定的 setInterval，每 3.6 秒换一张。现在冲刺要停得短，
   * 固定间隔就做不到——所以改成自己排下一次的 setTimeout。
   * 停止时 stopWork 会把待排的那一次清掉，不会漏跑。
   */
  function nextPose() {
    // 正在说话：这一格让给她，轮播停在这儿等（work.pose 不动，所以恢复时接着的那一格
    // 就是被打断的那一格，而不是从头来）。到点或来了新台词都由 maybeSpeak 管。
    if (work.speakUntil) {
      var left = work.speakUntil - Date.now();
      if (left > 0) {
        paintSpeak(work.speakText);
        // 睡到「该收尾的那一刻」为止，不多不少：按 3.6 秒一格睡的话，
        // 这个上限会被拖到整格之后，最后那句台词要多挂将近一秒。
        work.poseTimer = setTimeout(nextPose, Math.min(POSE_MS, left));
        return;
      }
      work.speakUntil = 0;
      work.speakText = '';
    }
    var seq = poseSequence();
    work.pose = (work.pose + 1) % seq.length;
    var index = seq[work.pose];
    paintPose(index);
    work.poseTimer = setTimeout(nextPose, POSES[index].gap ? GAP_MS : POSE_MS);
  }

  function startWork() {
    // 已经在跑就别重来。状态广播来得很密，每次重置的话姿态会永远卡在第一张。
    if (work.startedAt) return;
    work.startedAt = Date.now();
    work.pose = 0;
    paintPose(0);
    tickElapsed();
    work.tickTimer = setInterval(tickElapsed, 1000);
    if (reducedMotion) return;   // 关掉动画的人就停在一张上，秒数照常走
    work.poseTimer = setTimeout(nextPose, POSE_MS);
  }

  /** 停止请求的兜底计时器。放在 stopWork 前面，别靠 var 提升兜着。 */
  var stopTimer = null;

  function stopWork() {
    work.startedAt = 0;
    // 说话状态跟着收掉：这一轮的话已经说完了，下一轮不该接着上一句。
    // **但 speakAt 留着**——那是对「哪句话已经念过」的记忆，清掉的话，万一宿主侧
    // 还留着上一轮的台词（广播没到），新一轮一开场它就会被当成新话说一遍。
    work.speakUntil = 0;
    work.speakText = '';
    // 轮播现在是自己排下一次的 setTimeout（见 nextPose），用 clearInterval 清
    // setTimeout 在浏览器里也行，但写 clearTimeout 更不容易让人误会。
    if (work.poseTimer) { clearTimeout(work.poseTimer); work.poseTimer = null; }
    if (work.tickTimer) { clearInterval(work.tickTimer); work.tickTimer = null; }
    // 跑完了就把按钮复位，下一次「正在执行」才是干干净净的一个「停止」。
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    paintStop(false);
  }

  // ---------------- 停止 ----------------
  //
  // cancel() 在服务端只是**递个请求**，不是「等它停」——真正停下要等驱动收敛，
  // 到那时候服务端才把 running 翻成 false 推过来。所以按下去之后按钮自己禁用、
  // 改文案，等那个状态翻：既让人看见「按到了」，也防连按好几下。
  function paintStop(stopping) {
    var b = $('btnStop');
    b.disabled = stopping;
    b.textContent = stopping ? '正在停…' : '停止';
  }

  function requestStop() {
    var b = $('btnStop');
    if (!state.running || b.disabled) return;
    paintStop(true);
    api('/mini/api/stop', { method: 'POST', body: '{}' })
      .then(function () {
        // 正常情况：几百毫秒内 status 事件就到了，stopWork() 会把按钮复位。
        // 但万一那一刻连接正好断了，就会永远卡在「正在停…」——留个兜底，
        // 十秒还没翻就把按钮放回去，让人能再按一次，而不是干瞪眼。
        stopTimer = setTimeout(function () {
          stopTimer = null;
          if (state.running) {
            paintStop(false);
            toast('还没停下来。再按一次；要是电脑上还挂着一道题，先把它答掉。');
          }
        }, 10000);
      })
      .catch(function (err) {
        paintStop(false);
        // 「这个会话现在没在跑」**不是失败**：电脑那边已经停了、或者这一轮根本还没起。
        // 2026-11-25 真机上按停止后弹的就是这类提示，用户读成「停止失败」。
        // 遇到它就把本地状态纠正过来，别让人接着按。
        var msg = err && err.message ? String(err.message) : '';
        if (msg.indexOf('没在跑') >= 0) {
          setRunning(false);
          toast('电脑那边已经停了。');
          return;
        }
        // 剩下的才是真没发出去（断网、口令过期、服务没开）。把原因带出来，
        // 不要再用一句含糊的「停止失败」把错误吞掉。
        toast(msg ? ('停止没发出去：' + msg) : '停止没发出去：连不上电脑');
      });
  }

  $('btnStop').addEventListener('click', requestStop);

  /**
   * 把手机上答的题交回电脑，回一句实话。
   *
   * 回的是三种结果，不是一个「成没成」——因为两种失败要说不同的话：
   *   'ok'      电脑收下了；
   *   'late'    这题已经交回电脑了（插件回 409），得让用户去电脑上答；
   *   'failed'  压根没发出去（连不上），卡片留着，手一按还能再试。
   *
   * 原来那一段是按下就先把卡片收掉、发失败也咽着不说（当时的理由是「电脑那边等不到
   * 会自己还给浏览器」）。可电脑那边还在等着，手机上却静悄悄——用户看到的只有
   * 「我点了，没反应」（2026-09-27 用户报的正是这一幕）。所以这里只做一件事：
   * 把实情如实报出来，怎么显示由上面那张卡片决定。
   */
  function sendAnswer(id, answers) {
    return api('/mini/api/answer', {
      method: 'POST',
      body: JSON.stringify({ id: id, answers: answers }),
    })
      .then(function () { return 'ok'; })
      .catch(function (err) {
        return err && err.status === 409 ? 'late' : 'failed';
      });
  }


  /** 手机把审批结论交回电脑。三种结果和上面那条一样：成了 / 晚了 / 没送出去。 */
  function sendApproval(id, allow) {
    return api('/mini/api/approval', {
      method: 'POST',
      body: JSON.stringify({ id: id, decision: allow ? 'allow' : 'deny' }),
    })
      .then(function () { return 'ok'; })
      .catch(function (err) {
        return err && err.status === 409 ? 'late' : 'failed';
      });
  }
  // ---------------- 排队中的指令 ----------------
  //
  // 跑着任务时接着发的那几条不会丢，而是排进 agent 的收件箱（`followup()` 的语义
  // 就是「排队一个后续轮次」），等当前这一轮结束再跑。既然收下了，就必须让用户看见
  // 它排在哪——尤其单帧模式下，你发出去的那句话在别处**一个字都看不见**
  // （那一模式只显示回复），没有这块就等于「发出去了没反应」。
  //
  // 队列每次由服务端现读 agent 的收件箱，手机不自己记一份，所以不存在两边对不上。
  function paintQueue() {
    var el = $('queue');
    var list = state.queued || [];
    // 刻度尺上第一个点永远是**正在跑的那条**，后面每个点对应一条真排在队里的指令。
    //
    // 2026-09-27 用户裁决：**队列是空的就整块收起来，不显示。**
    // 上一版这里是「只要在跑就留着」，理由是一个金点表示"你这一轮正是第 1 步"；
    // 用户实际看到的是「排队中 0 条」配一个孤零零的点，判定为噪音。撤销。
    // （上面那段注释里"哪怕只有一格，秩序也在"的说法同样作废。）
    if (!list.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    // 最多画 12 个点：再长这条尺子就成噪点了，超出缀一个省略号。
    var nodes = '<div class="q-node cur"><i></i><b>1</b></div>';
    var shown = Math.min(list.length, 11);
    for (var n = 0; n < shown; n += 1) {
      nodes += '<div class="q-node"><i></i><b>' + (n + 2) + '</b></div>';
    }
    if (list.length > shown) nodes += '<div class="q-node"><i></i><b>…</b></div>';
    var rows = '';
    for (var i = 0; i < list.length; i += 1) {
      // 插话和排队**要分得出来**（2026-10-06）：服务端每条都带 placement，
      // `next-step` 是插话（下一个步骤边界就取走，通常几秒），
      // `next-turn` 是排队（等这一轮跑完，可能几分钟）。原来两条画得一模一样。
      var isSteer = list[i].placement === 'next-step';
      rows += '<div class="q-row">'
        + (isSteer ? '<span class="q-tag">插话</span>' : '')
        + '<span class="q-text">' + escapeHtml(list[i].text) + '</span>'
        + '<button class="q-drop" type="button" data-drop="' + escapeHtml(list[i].id) + '"'
        + ' aria-label="撤掉这条"><svg viewBox="0 0 24 24" aria-hidden="true">'
        + '<path d="M6 6l12 12M18 6L6 18"/></svg></button></div>';
    }
    // 标题得跟着实际内容说：**只要有一条插话，「跑完这轮就轮到它们」就是假话**。
    // 三种情况各说各的，不糊一句通用的。
    var steerCount = 0;
    for (var k = 0; k < list.length; k += 1) {
      if (list[k].placement === 'next-step') steerCount += 1;
    }
    var waitCount = list.length - steerCount;
    var head = steerCount && waitCount
      ? '插话 ' + steerCount + ' 条（下一步就看到） · 排队 ' + waitCount + ' 条'
      : steerCount
        ? '插话 ' + steerCount + ' 条 · 它下一步就看到'
        : '排队中 ' + list.length + ' 条 · 跑完这轮就轮到它们';
    el.innerHTML = '<div class="q-head">' + head + '</div>'
      + '<div class="q-scale">' + nodes + '</div>' + rows;
  }

  /**
   * 撤掉一条还在排队的指令。
   *
   * 撤不掉是正常情况之一：手机上这份队列是上一次推送时的样子，这中间它完全可能
   * 已经轮到自己开始跑了。那时候服务端会说「撤不回来了」，这里如实转达，
   * 并且刷新一次，让界面跟上真实状态——不能假装撤掉了。
   */
  function requestUnqueue(id) {
    // 成功失败都由服务端推一份最新的队列过来（失败时也要推——见 onUnqueue 的说明），
    // 所以这里不用自己去拉，只需要把失败原因转达给用户。
    api('/mini/api/unqueue', { method: 'POST', body: JSON.stringify({ id: id }) })
      .catch(function (err) { toast(err.message || '撤不回来'); });
  }

  $('queue').addEventListener('click', function (e) {
    // **必须从被点的元素往上找到那个真按钮。** ✗ 是画在按钮里面的 SVG 图形，手指落上去
    // 时 e.target 是图形本身，读不到按钮身上的编号。用户 2026-09-28 实机报「排队框的 ✗
    // 点了没反应」就是这么来的：旧写法 `e.target.getAttribute('data-drop')` 拿到 null，
    // 然后静默什么都不做。按钮只有 24×24、图形 12×12，所以旧写法几乎必然踩中。
    var hit = e.target && e.target.closest ? e.target.closest('.q-drop') : null;
    var id = hit ? hit.getAttribute('data-drop') : null;
    if (id) { requestUnqueue(id); return; }
    // 找到了按钮却没有编号：这是代码毛病。说一声，别静默——静默失败是最难查的那一类。
    if (hit) toast('这条撤不了：没带上编号');
  });

  /** 让「正在执行」那块跟着 state.running 显隐。 */
  function paintWork() {
    var el = $('work');
    var queued = (state.queued || []).length;
    // 队列也算「还有活儿」。正常情况到不了「闲着但队列非空」（followup 总会唤醒驱动），
    // 但停掉当前这一轮之后、队列还没接上的那一小段就是这种状态——
    // 那块东西不该先消失一下再冒出来。
    //
    // 但**正在流式写回答的时候要收起来**：回答本身已经在屏幕上长出来了，
    // 底下再挂一只鲸鱼娘就是重复——用户要看的字正在往上冒，那块既占地方又抢注意力。
    // 用户 2026-09-22 实机提的：「内容开始流式生成的时候，鲸鱼娘的动画就可以消失了」。
    // 注意这里用 state.live 判断，不是「有没有在跑」——跑着但还没到吐字那一步
    // （比如正在调工具）时，鲸鱼娘还是要留着，那是它唯一该出现的时候。
    var busy = (state.running || queued > 0) && !state.live;
    el.hidden = !busy;
    if (busy) {
      startWork();
      // 台词每次随快照重算一遍。**必须放在 startWork 之后**：startWork 会先画第 0 张，
      // 反过来的话它会把这句台词盖掉，用户看到的是「收到，这就去办」而不是她的自说自话。
      maybeSpeak();
    } else stopWork();
    paintQueue();
  }

  // ---------------- 渲染 ----------------
  function setStatus(kind, text) {
    dotEl.className = 'dot ' + kind;
    statusEl.textContent = text;
  }
  function updateStatusUI() {
    if (!state.connected) { setStatus('err', '未连接'); return; }
    if (state.running) { setStatus('run', '运行中…'); return; }
    setStatus('ok', '已连接');
  }
  function setRunning(running) {
    state.running = !!running;
    // 这里原来会把输入框和发送按钮一起禁用。现在不禁了：跑着的时候**可以接着发**，
    // 那条会排队（见 send 的说明）。禁掉输入框等于把「排队」这条路从界面上封死，
    // 而 DSH 本身在跑着的时候是收的。
    updateStatusUI();
    // 放这里而不是 render() 里：SSE 的 status 事件只调 setRunning、不重绘，
    // 漏了这一处的话「运行中」变了而鲸鱼娘不出现。
    // 另外它也是**唯一**会调 paintWork 的地方，而 paintWork 还要看 state.live
    // （流式一露头就把鲸鱼娘收起来）。快照每次都带 running，所以 applySnapshot
    // 会走到这儿、live 的变化也就跟着生效了——别把这个调用挪走。
    paintWork();
  }

  /**
   * 单帧模式：「这一条回答」有没有已经带用户滚过顶了。
   *
   * **用 timestamp 当身份**，因为它是这里唯一稳定、且只在真推了一条新回答时才变的字段
   * （`pushReply` 每次都现取 `Date.now()`；重连、SSE 重推、切模式、从后台回来
   * 都只是把同一条回答重新渲染一遍，timestamp 不变）。
   *
   * 用户 2026-09-23 提的：「手机端的单帧模式，回答出现的时候，页面应该跳到顶部，
   * 方便用户阅读。」不记这个的话：一条长结论渲染出来，用户看到的是最后一行，
   * 得自己往上翻才读得到开头。
   *
   * 记成「已经为哪一条滚过顶」而不是一个「刚跳过」的布尔量，是为了不误伤上面那几种
   * 重新渲染——那些时候用户可能正读到一半，把他弹回顶部比不跳还烦人。
   * 初始值 0：开机第一次渲染时任何一条回答的 timestamp 都比它大，于是会跳一次，
   * 正好是「打开页面从最新那条的开头读起」。
   */
  var scrolledReplyAt = 0;

  function renderMinimal() {
    mainEl.classList.remove('center');
    var latest = state.latest;
    var live = state.live || '';
    var parts = [];
    // 「正在执行」不拼进这块 HTML——它是常驻的 #work，由 paintWork() 控制显隐。
    // 但它仍然显示在回答**下方**，不顶掉回答：原来它排在最前面并且直接 return，
    // 于是刚发完指令，上一步的结果就整块消失，用户看不到自己上一步得到了什么。
    if (latest && latest.text) {
      // 「已停止」留在正文**上方**：它是给正文打的预防针（你收到的只是半句），
      // 得在读到正文之前看到。
      // 复制按钮则挪到正文**下方、靠左**——原来在上面靠右，手机上拇指够不着，
      // 而且会比正文先入眼。
      var stopped = latest.interrupted ? '<span class="stopped">已停止</span>' : '';
      // 这一轮花了多少（2026-11-27）：和聊天模式同一个徽标、同一个位置（正文左上角）。
      parts.push((stopped ? '<div class="reply-bar">' + stopped + '</div>' : '')
        + tokenBadge(latest.usage)
        + '<div class="md">' + mdToHtml(latest.text) + '</div>'
        + '<div class="reply-foot">'
        + '<button class="copy" type="button" aria-label="复制全文" title="复制全文"'
        + ' data-copy="' + escapeHtml(latest.text) + '">' + ICON_COPY + '</button>'
        + '</div>');
    }
    // 刚跑完的那条指令也要露出来（判据和为什么见 commandTail）。
    // 「正在执行」那块照旧：它是常驻的 #work，跟这里没关系。
    var tail = commandTail();
    if (tail) parts.push(commandBlock(tail));
    // 子智能体刚完工的那条通知同理（判据见 noticeTail）。它出现在这里的时机很窄——
    // 通知一到，父级通常会被唤醒作答，那条回答很快就会把它顶掉——但那一段空窗里
    // 屏幕上什么都不变的话，用户会以为子智能体那边没消息。
    var note = noticeTail();
    if (note) parts.push(noticeBlock(note));
    if (live) parts.push(liveBlock(live));
    if (parts.length) {
      var stick = atBottom();
      replyEl.innerHTML = parts.join('');
      // 流式的时候得跟着往下滚，不然新写出来的内容在屏幕外面，看起来像卡住了。
      // 但只在用户本来就在底部时才跟——他翻上去看历史的时候别拽他回来。
      if (live && stick) mainEl.scrollTop = mainEl.scrollHeight;
      // 单帧模式专属：**答案落定的那一刻**跳到顶部，让人从第一行开始读。
      //
      // 判据是 timestamp 变了，不是「渲染了一次」——重连、SSE 重推、切模式、
      // 从后台回来都会重新渲染同一条回答，那些时候用户可能正读到一半，
      // 弹回顶部比不跳还烦人（见 scrolledReplyAt 的说明）。
      //
      // 和上面那条黏底不冲突，两者管的是不同时刻：流式那会儿（live 还在）
      // 答案没落定，该跟着往下走；落定之后才轮到这一条把它拉回开头。
      // 也别跟下面 send() 里那条「按了发送无条件回底部」搞混——那是用户自己的
      // 主动动作，他想看自己刚发出去的那条；这条是回答到了，他要读回答。
      if (latest && latest.timestamp && latest.timestamp !== scrolledReplyAt) {
        scrolledReplyAt = latest.timestamp;
        mainEl.scrollTop = 0;
      }
      return;
    }
    if (state.running) {
      replyEl.innerHTML = '';
      return;
    }
    // 正在去读这个会话的记录：这时候说「在下面输入一条指令」是不对的——
    // 这个会话其实有历史，只是还没读完。单帧模式只显示最后一条回复，
    // 那一条也在这份记录里。
    if (state.historyLoading) {
      replyEl.innerHTML = '<div class="placeholder">正在读取这个会话的记录…</div>';
      return;
    }
    replyEl.innerHTML = '<div class="placeholder">在下面输入一条指令，'
      + '这里只会显示 AI 的最终回复。<br>中间的工具调用和执行过程不会传过来。</div>';
  }

  /**
   * 正在流出来的那一段。
   *
   * **刻意和答案画得不一样**：上面一条虚线，末尾一个一闪一闪的竖条，而且**没有
   * 复制按钮**。这三样都在说同一句话——「这不是最终答案，还会变」。等真正的答案
   * 落定，这一整块会被换掉。
   *
   * 为什么要区分得这么清楚：流式阶段拿不到完整内容，没法提前知道模型这一步会不会
   * 去调工具。服务端已经先用一小段「按兵不动」把绝大多数中间旁白挡在外面了
   * （见 lib/index.js 的 STREAM_GRACE_MS），但那是启发式、不是判据。万一漏过来
   * 一句旁白，它会被撤回——那时候用户看到的应该是「刚才那段是过程，不作数」，
   * 而不是「我的回答怎么没了」。
   */
  function liveBlock(text) {
    // 徽标在 `.md` **外面**：paintLive() 只换 `.live .md` 的 innerHTML，放里面会被
    // 每一帧冲掉（见 paintLive 的说明）。
    return '<div class="live">' + tokenBadge(state.usage)
      + '<div class="md">' + mdToHtml(text) + '</div></div>';
  }

  /**
   * 「这次回答花了多少 token」的小徽标（2026-11-27）。
   *
   * 口径是**计费总量**：未缓存输入 + 缓存读 + 缓存写 + 输出（用户 2026-11-27 定的）。
   * 生成中的那个数字前面带 `≈`——它是按字数估的，落定后会被精确值换掉。
   *
   * **自带格式化，不借 saTokens**：这个函数被 page.test.mjs 的切片单独抠出来跑，
   * 切片里没有 saTokens（它在子智能体那一段），借了就是 ReferenceError。
   */
  function tokenBadge(usage) {
    if (!usage) return '';
    var total = usage.total;
    if (typeof total !== 'number' || !isFinite(total) || total <= 0) return '';
    var est = usage.estimated === true;
    return '<span class="tok"' + (est ? ' data-est="1"' : '')
      + ' title="' + tokTitle(usage) + '">'
      + (est ? '≈' : '') + tokShort(total) + ' tok</span>';
  }

  /** 紧凑数字：和子智能体那栏同一个口径（—/123/1.2k/3.4M）。 */
  function tokShort(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1000000).toFixed(1) + 'M';
  }

  /** 悬停（长按）看到的那行字：把总数拆开说清楚，不然只有一个数看不懂。 */
  function tokTitle(usage) {
    var parts = ['本轮 ' + tokShort(usage.total) + ' tok（计费总量）'];
    if (typeof usage.billed === 'number') parts.push('输入 ' + tokShort(usage.billed));
    if (typeof usage.output === 'number') parts.push('输出 ' + tokShort(usage.output));
    if (usage.estimated === true) parts.push('生成中，估的');
    return parts.join(' · ');
  }

  /**
   * 历史里的一条指令（`role:'command'`）：这个会话执行了 /xxx，跑到哪一步了。
   *
   * 为什么单独一种长相：它既不是用户说的话，也不是 AI 说的话，而是**会话做的一个
   * 动作**。套上气泡就成了一句人说的话，会被当成回答去读；给它复制按钮也没有意义
   * （「/compact 执行中…」没有拿走的必要）。所以收成一行紧凑的条目：名字用等宽字体，
   * 后面直接跟结果。
   *
   * 三种状态里只有 running 是「还不知道结果」：服务端在这一条上**不报进度**，
   * 所以只能说「执行中…」——编一个百分比就是撒谎。
   *
   * 这两个函数夹在 liveBlock 和 renderChat 中间是有原因的，**别挪**：page.test.mjs
   * 是按源码里的锚点串切片的——聊天模式那一套从 liveBlock 那一段切到 render 那一段，
   * 单帧模式那一套从 scrolledReplyAt 那一段切到 renderChat 那一段，两把刀的交集就是
   * 这里。放到交集外面，总有一套测试一跑就 ReferenceError。
   * （顺带一句：这段注释里**不能**写出那几个锚点串的完整样子，否则 indexOf 会先命中
   *   注释、把切片截断，报出来的是「SyntaxError」而不是人话。）
   */
  function commandBlock(m) {
    // args 是名字后面**原样**的输入（含分隔空格），可能为空串——所以直接拼，
    // 不自己补一个空格：补了就把「用户到底敲了什么」改样了。
    var line = '/' + (m.name || '') + (m.args || '');
    var kind = m.kind === 'error' ? 'error' : (m.kind === 'success' ? 'success' : 'running');
    var res = kind === 'error' ? (m.text || '没跑起来')
      : (kind === 'success' ? (m.text || '完成') : '执行中…');
    return '<div class="cmd ' + kind + '">'
      + '<span class="cmd-line">' + escapeHtml(line) + '</span>'
      + '<span class="cmd-res">' + escapeHtml(res) + '</span></div>';
  }

  /**
   * 单帧模式要跟着显示的那条指令：**历史里最后一条**，而且得真的是一条指令。
   *
   * 为什么要单独处理：单帧模式整屏只留最新一条回复，而指令**不产生回复**——用户点一下
   * /compact，这里要是什么都不画，屏幕上就是一动不动，看着像点了个没反应的按钮。
   *
   * 用「最后一条」而不是「最近一条指令」：中间要是夹了别的消息（指令跑完模型又答了
   * 一句），那条指令已经不是最新的事了，再把它贴在最下面就成了过期通知。
   *
   * 最后还有一道时间判断，别删。单帧模式的回答是走 SSE 的 reply 那条路来的，它
   * **不往 history 里塞东西**（只有聊天模式才塞），所以 history 的尾巴会一直停在那条
   * 指令上。不加这一道，新回答到了之后底下还挂着一条「执行中…」，看着像它卡住了。
   */
  function commandTail() {
    var h = state.history || [];
    var last = h.length ? h[h.length - 1] : null;
    if (!last || last.role !== 'command') return null;
    var lt = (state.latest && state.latest.timestamp) || 0;
    if (lt && last.timestamp && last.timestamp < lt) return null;
    return last;
  }

  /**
   * 一个会话 id 的「能区分人的那一段」。
   *
   * **不能直接取 id 的开头几位**：本机的会话 id 长这样 `session-80fd8f3c-…`，
   * 开头八位永远是 `session-`，一排子智能体就会全叫同一个名字。导航栏那边踩过
   * 同一个坑，page.test.mjs 里有一条守卫专门钉着它。所以先把 `session-` 这段
   * 人人相同的前缀去掉，再取一段开头——留下的才是真能区分它们的字符。
   */
  function shortSessionId(id) {
    var s = String(id || '');
    if (s.slice(0, 8) === 'session-') s = s.slice(8);
    if (!s) s = String(id || '');
    return s.slice(0, 8);
  }

  /**
   * 子智能体完工的那张卡片（聊天记录里的一种条目）。
   *
   * 它是**第三样东西**：不是用户说的话，也不是模型的回答，而是「这个会话派出去的
   * 一件事有结果了」。所以既不套用户气泡、也不画成回答正文——套上气泡就变成
   * 「我说过这句话」，混进正文又会被读成模型的话，两种都是假的。
   *
   * 展开/收起交给原生 `<details>`：不写一行脚本、不加一个关键帧，键盘和读屏也都认。
   *
   * 正文**原样贴出来**（`white-space: pre-wrap`，见 .sa-card .sa-body），不再解析：
   * 这段话是 DSH 生成的——它先说清「谁、为什么结束」，再把子智能体最后的原话接上。
   * 那是**转述**，不该由我们这边的渲染器再加工一遍。
   */
  function noticeBlock(m) {
    var who = m.senderSessionId ? shortSessionId(m.senderSessionId) : '';
    var when = m.timestamp ? timeLabel(m.timestamp) : '';
    return '<details class="sa-card"><summary><b>子智能体完工</b>'
      + (who ? '<span>' + escapeHtml(who) + '</span>' : '')
      + (when ? '<span>' + escapeHtml(when) + '</span>' : '')
      + '</summary><div class="sa-body">' + escapeHtml(m.text || '') + '</div></details>';
  }

  /**
   * 单帧模式要跟着显示的那条通知：**历史里最后一条**，而且得真的是一条通知。
   *
   * 判据和 commandTail 完全一样，连那道时间判断都照抄，理由也一样：
   *   - 用「最后一条」而不是「最近一条」：中间要是夹了别的消息（父级被唤醒后又答了
   *     一句），那条通知已经不是最新的事了，再贴在最下面就成了过期通知；
   *   - 单帧模式的回答走 SSE 的 reply 那条路，**不往 history 里塞**，所以 history
   *     的尾巴会一直停在那条通知上——不挡一下，新回答到了之后底下还挂着它。
   */
  function noticeTail() {
    var h = state.history || [];
    var last = h.length ? h[h.length - 1] : null;
    if (!last || last.role !== 'notice') return null;
    var lt = (state.latest && state.latest.timestamp) || 0;
    if (lt && last.timestamp && last.timestamp < lt) return null;
    return last;
  }

  /**
   * 该不该自动滚到底。
   *
   * 用户 2026-09-22 实机提的：「有动画的时候手机端页面运动到上面都会自动调回底部，
   * 这种机制没必要吧。」原来每次重画都无条件滚到底，而鲸鱼娘一帧一动、流式一秒七次，
   * 于是想往上翻根本翻不动——手一松就被拽回去。
   *
   * 改成只在**本来就在底部**的时候才跟着滚：新内容进来时视野跟着走，
   * 用户自己翻上去看历史时就不打扰他。
   *
   * 注意：这个判断必须在改 innerHTML **之前**做。改写内容本身会把滚动位置顶回去，
   * 改完再问「在不在底部」永远是「在」。
   */
  function atBottom() {
    // 48px 是「差不多到底了」的容差。手指滚动的惯性、地址栏收起都会差几个像素，
    // 卡得太死会变成「我明明就在底部，它却不跟着走了」。
    return mainEl.scrollHeight - mainEl.scrollTop - (mainEl.clientHeight || 0) < 48;
  }

  /**
   * 「对齐开头」到底对齐谁：**正文第一行**，不是外面那层容器。
   *
   * 流式那段把虚线移到不占高度的 ::before 上，第一行和落定回答的第一行在同一高度；
   * 这条函数保证两边量的都是**正文第一行**，而不是外面那层容器。2026-10-22 真机报的
   * 「落定第一行往上跳 14px」就是按容器顶量出来的。
   *
   * 用户气泡没有 `.md`，它自己的内边距就是文字位置，直接返回气泡本身；
   * 被按停的回答前面有「已停止」那条，要让它露出来，不能只锚正文。
   */
  function firstContentLine(el) {
    if (!el || typeof el.querySelector !== 'function') return el;
    if (el.classList && el.classList.contains('bubble')) return el;
    var first = el.firstElementChild;
    if (first && first.classList && first.classList.contains('reply-bar')) return first;
    var md = el.querySelector('.md');
    if (!md) return el;
    return md.firstElementChild || md;
  }

  /**
   * 把某一块的**开头**对齐到视野顶部。
   *
   * **2026-11-28 起没有调用方了**：用户改口不要「落定停在回答开头」，改成一律跟着最新
   * 内容走（见 scrollChat）。函数和它的单测留着没删，理由是这条口径已经翻过两次面
   * （09-24 要、10-22 强化、11-28 撤）——再翻回来时别重写一遍，而且「量正文第一行、
   * 不量外层容器」那个坑就埋在 firstContentLine 里。
   *
   * 用两个矩形的差值算，不用 `offsetTop`：`main` 上没有 `position: relative`，
   * `offsetTop` 会一路找到 body 去，算出来是错的。矩形差值不管定位上下文怎么变都对。
   *
   * 留 12px 空隙：`main` 自己带 16px 内边距，滚下去之后那段内边距就滚没了，
   * 不留缝的话回答的第一行会顶在屏幕最上沿，看着像被切掉了。
   */
  function pinToTop(el) {
    var line = firstContentLine(el);
    if (!line || typeof line.getBoundingClientRect !== 'function') return;
    if (typeof mainEl.getBoundingClientRect !== 'function') return;
    var gap = line.getBoundingClientRect().top - mainEl.getBoundingClientRect().top;
    // 这里**不用**为顶上那颗「往上滑看更早的」让高度：对齐开头只在「他本来就在底部」
    // 的时候做（见 scrollChat），而那时候那颗提示是收着的（见 chatNoteVisible）——
    // 让高度反而会凭空多出一段空白。
    mainEl.scrollTop += gap - 12;
  }

  /**
   * 聊天记录**一次铺多少轮**，以及这次已经铺到第几轮。
   *
   * 用户 2026-09-30 报的：在导航栏点一个没选中的会话，切过去很慢。查下来不是网络、
   * 也不是服务端取数（本机实测那三个接口 168 / 36 / 107 毫秒），而是这一页**一次把
   * 推上来的 200 条记录全铺出来**。这 200 条本来就已经在页面手里了——所以「往上多放
   * 一点」是个纯本地动作，不用再问服务端，也该是瞬时的。
   *
   * **2026-11-27 改单位：条 → 轮。** 原来按条切（40 条），可一轮里的条数很不齐
   * （一条指令 + 好几段回答 + 子智能体通知都可能算一轮），40 条有时只够一轮、有时横跨
   * 十几轮，首屏看到的「最近一段」长度飘。用户要的是「只留最近 3 轮」，按轮切才对得上。
   *
   * 3 这个数：手机上一屏通常放得下一到两轮长回答，3 轮首屏就够看；要往前翻一次再放 3 轮。
   */
  var CHAT_TURNS = 3;
  var chatTurns = CHAT_TURNS;   // 从最新往回数，这次铺到第几轮
  var chatTurnsFor = null;      // 上面这个数是哪个会话的（换会话要收回首屏，见 renderChat）
  var chatTotalTurns = 0;       // 本地一共多少轮（由 buildChat 记）
  var chatHiddenTurns = 0;      // 窗口外面还压着多少轮（那句提示要用）
  var chatLoaded = 0;           // 本地一共有多少条可铺（滤掉排队那条之后），由 renderChat 记
  var chatGrowArmed = true;     // 这一轮靠近顶部已经放过一屏没有（见 maybeGrowChat）
  /**
   * 页面**自己**刚把页面滚到哪儿了（-1 = 没滚过）。
   *
   * 为什么要记它：`growChat` / `fetchOlderChat` 往顶上补内容之后要把位置校回来
   * （见那两处），那一下也是自己滚的——收到的那一下滚动事件不算「用户往上翻」，
   * 不记的话一次手势就能连着放好几屏。
   *
   * 2026-11-28 之前它还兼着一件事：`scrollChat` 把「最新那条回答的开头」对齐到视野
   * 顶部时，那个位置经常落在「离顶一屏以内」，`maybeGrowChat` 会把它当成「用户滑到顶
   * 了」，打开会话那一下白多铺一屏（2026-11-27 离线靶场实测：首屏 6 轮）。现在
   * `scrollChat` 不再对齐开头了，这条只剩「黏底那一下也记一笔」的用处。
   */
  var chatTopOwned = -1;

  /**
   * 每一行属于哪一轮——给「按轮切窗口」用的分组键。
   *
   * 口径（和 DSH 的事件一致）：
   *   · `turn` 是数字的，按轮号分组；
   *   · **没有轮号的行跟着下一轮走**：指令行 `/xxx` 本来就是给下一轮下的，子智能体通知
   *     也是那条指令派出去的事。跟着上一轮会把它们变成上一轮的尾巴；
   *   · 尾部那些后面再没有轮了的（指令已发、回答还没来），跟着上一轮；
   *   · 整串都没有轮号（老记录、或者只有指令行），当成一组 `'pre'`。
   *
   * 返回和 list 等长，每项是组键（数字或 `'pre'`）。
   */
  function chatTurnKeys(list) {
    var keys = [];
    var i;
    for (i = 0; i < list.length; i++) {
      keys.push(list[i] && typeof list[i].turn === 'number' ? list[i].turn : null);
    }
    var next = null;
    for (i = keys.length - 1; i >= 0; i--) {
      if (keys[i] === null) keys[i] = next;
      else next = keys[i];
    }
    var prev = null;
    for (i = 0; i < keys.length; i++) {
      if (keys[i] === null) keys[i] = prev;
      else prev = keys[i];
    }
    for (i = 0; i < keys.length; i++) if (keys[i] === null) keys[i] = 'pre';
    return keys;
  }

  /** `[0, end)` 里有多少轮（组键已经按轮号排好，相邻不同就算新的一轮）。 */
  function countTurns(keys, end) {
    var n = 0;
    var mark = null;
    for (var i = 0; i < end; i++) {
      if (keys[i] !== mark) { mark = keys[i]; n += 1; }
    }
    return n;
  }

  /** 窗口上沿：留下最后 `turns` 轮，返回第一行的下标。 */
  function turnWindowStart(keys, turns) {
    var seen = [];
    var start = keys.length;
    var want = Math.max(1, turns || 0);
    for (var i = keys.length - 1; i >= 0; i--) {
      if (seen.indexOf(keys[i]) < 0) {
        if (seen.length >= want) break;
        seen.push(keys[i]);
      }
      start = i;
    }
    return start;
  }

  /** 触发线：离顶一屏的四分之一以内。放一屏和那颗提示共用这一条，别写成两个数。 */
  function chatEdge() {
    return Math.min(160, Math.max(60, (mainEl.clientHeight || 0) / 4));
  }

  /** 顶上那颗「往上滑看更早的」的元素（没铺出来就没有）。 */
  function moreNoteEl() {
    return replyEl.querySelector ? replyEl.querySelector('.more-note') : null;
  }

  /**
   * 那句提示现在该不该露脸：**近了顶部、又不在底部**。
   *
   * 两个条件缺一不可——
   *   · 离顶远了它就没用：再往上滑一下就自动放一屏，用不着它催；
   *   · 在底部时它必须收起来（用户 2026-09-30 真机提的那条）：那句话是催人往上滑的，
   *     人已经在最底下读内容了，它挂在那儿只剩挡视线。
   */
  function chatNoteVisible() {
    if (atBottom()) return false;
    return mainEl.scrollTop <= chatEdge();
  }

  /**
   * 把提示的露 / 收跟当前位置对齐。
   *
   * 这是**滚动时**的那一半。重画只在快照来的时候发生，而用户从中间一路滑到底
   * 是不会等快照的——不在滚动里收，那条提示就会一直挂在顶上（真机就是这么发现的）。
   */
  function paintChatNote() {
    var el = moreNoteEl();
    if (!el || !el.classList || typeof el.classList.toggle !== 'function') return;
    el.classList.toggle('hide', !chatNoteVisible());
  }

  /** 这一条用户消息是不是长到该折叠。按字数与行数估，手机宽度下 240 字约十几行。 */
  function isLongUserText(text) {
    var s = text || '';
    if (s.length > 240) return true;
    return s.split('\n').length > 9;
  }

  /** 展开过的用户消息（键 = 会话 + 时间戳）。重画时靠它把「收起」状态留住。 */
  var expandedUserMsgs = Object.create(null);

  /**
   * 历史里「你答过的一道题」。
   *
   * 长相对齐 .cmd（细线框、不是气泡）：它是**你对一道题的结论**，既不是你说的话，
   * 也不是模型答的话。所以不套 .bubble、也不给复制按钮——复制一句「你选了 A、B」
   * 没有意义。
   *
   * 数据来自工具结果（见 lib/answer.js）：`items` 逐题一条；`header` / `title` 只在
   * 题目的调用也在窗口里时才有，取不到就只显示答案本身，**不编一个问题出来**。
   */
  function answerBlock(m) {
    var items = Array.isArray(m.items) ? m.items : [];
    var rows = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var picked = Array.isArray(it.selected) ? it.selected : [];
      var custom = typeof it.custom === 'string' ? it.custom.trim() : '';
      var what = picked.length ? '你选了：' + picked.join('、') : '';
      if (custom) what = what ? what + '；你写了：' + custom : '你写了：' + custom;
      // 两样都没有的那一题不画：一个空 chip 比没有更让人糊涂。
      if (!what) continue;
      var q = it.header || '';
      if (!q && it.title) q = it.title.length > 24 ? it.title.slice(0, 24) + '…' : it.title;
      rows += '<span class="ans-row">'
        + (q ? '<span class="ans-q">' + escapeHtml(q) + '</span>' : '')
        + '<span class="ans-v">' + escapeHtml(what) + '</span></span>';
    }
    if (!rows) return '';
    return '<div class="ans">' + rows
      + (m.timestamp ? '<span class="ans-t">' + escapeHtml(timeLabel(m.timestamp)) + '</span>' : '')
      + '</div>';
  }

  // ——— 「刚答完的那道题，选了些什么」（2026-11-27 晚）———
  //
  // 收摊那一下手机上必须**立刻**看见两件事：卡片没了、你选了什么。卡片靠收到的帧关
  // （见 closeAskCard）；「选了什么」原本只能等工具结果落定后再推一份 history
  // （最长 60 秒），用户答完盯着空白等一分钟，跟没做这个功能差不多。
  // 所以收摊时就把结果记在这里，直接画成一条 chip（和 history 里那条同一个 answerBlock）。
  // **服务端那条一到它就退场**：判据是答案本身（answerInHistory），不建表、不做 id 映射。
  var localAnswers = [];          // [{ qid, items, source, at }]
  var LOCAL_ANSWER_KEEP = 5;      // 只留最近几条：这是「刚答完」的临时显示，不是第二份历史

  /** 一份答案的身份：每题选中项 + 自己写的那句（用于和 history 里那条比对）。 */
  function answerSig(items) {
    var parts = [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i] || {};
      parts.push((Array.isArray(it.selected) ? it.selected.join('\u0001') : '') + '\u0002' + (it.custom || ''));
    }
    return parts.join('\u0003');
  }

  /** 这条答案已经在服务端那份 history 里了吗（到了就不画本地那条）。 */
  function answerInHistory(items) {
    var want = answerSig(items);
    if (!want) return true;
    var list = state.history || [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].role === 'answer' && answerSig(list[i].items) === want) return true;
    }
    return false;
  }

  /** 手机自己勾的那份 → chip 的形状（和 lib/answer.js 的 answerItems 必须一模一样）。 */
  function askItems(one) {
    var out = [];
    var qs = (one && one.questions) || [];
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i] || {};
      var picked = (one.picked && one.picked[i]) || {};
      var sel = Array.isArray(picked.selected) ? picked.selected.slice() : [];
      var custom = (picked.custom || '').trim();
      if (!sel.length && !custom) continue;
      out.push({ id: q.id || '', header: q.header || '', title: q.question || '', selected: sel, custom: custom });
    }
    return out;
  }

  /** 「你选了：A、B；你写了：…」（和 chip 同一套文案）。 */
  function answerLine(items) {
    var parts = [];
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i] || {};
      var picked = Array.isArray(it.selected) ? it.selected : [];
      var custom = (it.custom || '').trim();
      var what = picked.length ? '你选了：' + picked.join('、') : '';
      if (custom) what = what ? what + '；你写了：' + custom : '你写了：' + custom;
      if (what) parts.push(what);
    }
    return parts.join('；');
  }

  /**
   * 记一条刚答完的结果并重画；没有可显示的选择就不记——**不编**一句「你选了」。
   *
   * **同一条只记一次**（2026-11-27 晚修）：手机自己答完会走两次这儿——一次是 POST
   * 成功之后（见 askNext），一次是服务端那条 `question-done` 回来。两边带的是同一道题、
   * 同一份选择，按 `题号 + 答案内容` 认人，第二次只把时间往前推，不再记一条
   * （真机上就是这么冒出两条一模一样的 chip 的）。
   */
  function rememberAnswer(qid, items, source) {
    var sig = answerSig(items);
    if (!sig) return;
    var key = (qid || '') + '|' + sig;
    for (var i = 0; i < localAnswers.length; i++) {
      if (localAnswers[i].key === key) { localAnswers[i].at = Date.now(); return; }
    }
    localAnswers.push({ key: key, qid: qid || '', items: items, source: source || '', at: Date.now() });
    while (localAnswers.length > LOCAL_ANSWER_KEEP) localAnswers.shift();
    render();   // 总分发：单帧模式那边没有聊天记录，render() 自己落到 renderMinimal
  }

  /** 收卡之后说一句：谁答的（服务端如实说，猜不得）+ 选了什么。 */
  function saySettled(source, items) {
    var line = answerLine(items);
    var who = source === 'pc' ? '电脑上答的' : (source === 'feishu' ? '飞书上答的' : '');
    if (line) return toast(who ? who + '：' + line : line);
    if (source === 'pc') toast('这道题已经在电脑上答过了');
    else if (source === 'feishu') toast('这道题已经在飞书里答过了');
    else if (source === 'stop') toast('这一轮被你停掉了，这道题不用再答');
    else toast('这道题已经不在等你答了');
  }

  /**
   * 「这一轮的过程」：思考 + 工具步骤（2026-11-27 v2，聊天模式）。
   *
   * 三层折叠，和 DSH 桌面端的 turn-process 一个心思：
   *   ① 整组默认收起，标题行 =「过程 · N 步 · <最后一步的首行>」；
   *   ② 展开后每一步一行（思考行「思考 · 首行」、工具行「运行命令 · 参数摘要」）；
   *   ③ 再展开才是正文（思考全文 / 工具结果）。
   *
   * 为什么推倒 v1：v1 只有一个槽、只显示最后一行摘要，第二段思考一到第一段就被顶掉
   * （用户实机报的「第一条还没看完就没了」）。数据由服务端两条帧喂：
   * `thought`（带 step 号 + 增量 + 收尾全文）和 `step`（工具行）。
   *
   * 为什么不用「整串重画」：用户在读上面的内容时，500 毫秒一次重画会把滚动位置顶走。
   * 这里只动变化的那个节点（见 paintProcessLive）。
   */
  var THOUGHT_KEEP = 60;          // 一轮最多记几步（长回合别把页面撑爆）
  var THOUGHT_TEXT_MAX = 4000;    // 单步思考正文上限（和服务端 TRAJECTORY_MAX_CHARS 对齐）
  var thoughtGroupOpen = false;   // 整组展开过没有（默认折叠）
  var thoughtStepOpen = {};       // 单步展开状态：{ 步骤 key: true }

  /** 步骤身份：思考 `t<号>`、工具 `x<id>`、旁白 `y<id>`——几条帧各来各的，靠这个合成一列。 */
  function stepKey(step) {
    return (step.kind === 'tool' ? 'x' : step.kind === 'say' ? 'y' : 't') + step.id;
  }

  /** 一行的标题：工具是工具名，思考是正文首行（压成一行，80 字）。 */
  function stepTitle(step) {
    if (step.kind === 'tool') return trajToolTitle(step.name);
    var raw = String(step.text || step.detail || '');
    var lines = raw.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].replace(/\s+/g, ' ').trim();
      if (s) return s.length > 80 ? s.slice(0, 79) + '…' : s;
    }
    return '正在思考';
  }

  /** 标题行后半截：思考是首行摘录，工具是参数摘要（服务端压过，≤200 字）。 */
  function stepSubline(step) {
    if (step.kind === 'tool') return step.summary ? '· ' + step.summary : '';
    return '· ' + stepTitle(step);
  }

  /** 展开后看的东西：思考全文 / 工具结果（服务端已按 800 字截过）。 */
  function stepBodyText(step) {
    return step.kind === 'tool' ? String(step.output || '') : String(step.text || step.detail || '');
  }

  function stepRowHtml(step) {
    var key = stepKey(step);
    // 旁白（2026-11-27 晚）：照 PC 是**过程里的一段正文**——黑色、不套框、不折叠，
    // 也没有图标。和思考（灰的、点开才见正文）分得开：一个是「它想什么」，
    // 一个是「它对你说什么」。点不开，所以不留 summary。
    if (step.kind === 'say') {
      return '<li class="pstep-say" data-pstep="' + escapeHtml(key) + '">'
        + mdToHtml(step.text || '') + '</li>';
    }
    var cls = 'pstep';
    if (step.kind === 'tool') {
      if (step.state === 'running') cls += ' running';
      else if (step.state === 'error') cls += ' bad';
    } else if (!step.done) cls += ' live';
    var open = thoughtStepOpen[key] ? ' open' : '';
    var body = stepBodyText(step);
    var icon = trajIco(step.kind === 'tool' ? trajActivity(step.name) : 'thinking');
    return '<li><details class="' + cls + '"' + open + ' data-pstep="' + escapeHtml(key) + '">'
      + '<summary><span class="pstep-i">' + icon + '</span>'
      + '<span class="pstep-k">' + escapeHtml(step.kind === 'tool' ? stepTitle(step) : '思考') + '</span>'
      + '<span class="pstep-s">' + escapeHtml(stepSubline(step)) + '</span></summary>'
      + '<div class="pstep-body' + (body ? '' : ' empty') + '">' + escapeHtml(body) + '</div>'
      + '</details></li>';
  }

  /** 一组里有没有工具步：有就叫「过程」，只有思考就叫「思考」（抬头别骗人）。 */
  function stepsHasTool(steps) {
    for (var i = 0; i < steps.length; i++) if (steps[i].kind === 'tool') return true;
    return false;
  }

  /** 整组：一行组头 + 每步一行。`list` 是 { steps: [...] }。 */
  function processHtml(list) {
    var steps = (list && list.steps) || [];
    if (!steps.length) return '';
    var last = steps[steps.length - 1];
    var html = '<details class="pgroup"' + (thoughtGroupOpen ? ' open' : '') + ' data-pgroup="1">'
      + '<summary><span class="pgroup-k">' + (stepsHasTool(steps) ? '过程' : '思考') + '</span>'
      + '<span class="pgroup-n">' + steps.length + ' 步</span>'
      + '<span class="pgroup-s">· ' + escapeHtml(stepTitle(last)) + '</span></summary>'
      + '<ol class="psteps">';
    for (var j = 0; j < steps.length; j++) html += stepRowHtml(steps[j]);
    return html + '</ol></details>';
  }

  /** 回答还没落定时，过程清单挂在 live 区（在回答之前）。 */
  function processLiveHtml() {
    return processHtml(state.thinking);
  }

  /**
   * 流式那一下：**只动变化的节点**，不重画整串。
   *
   * 三种变化：新的一步（追加一行）、当前这一步的字（改标题 / 展开时才改正文）、
   * 工具结果落定（换状态、补正文）。找不到组（刚切会话、刚开一轮）才整画一次。
   *
   * 滚动：**只有本来就在底部**才跟着走（见 atBottom）——用户往上翻看历史时，
   * 500 毫秒一次的思考帧不该把他拽回来。
   */
  function paintProcessLive() {
    var t = state.thinking;
    if (!t || !t.steps || !t.steps.length) return;
    // 只有聊天模式画这一块（别的模式没有落点；切过去但连接还没重连时别再整屏重画）。
    if (state.mode !== 'chat') return;
    var group = replyEl.querySelector ? replyEl.querySelector('[data-pgroup]') : null;
    if (!group) { render(); return }
    var list = group.querySelector ? group.querySelector('.psteps') : null;
    if (!list) return;
    var stick = atBottom();
    for (var i = 0; i < t.steps.length; i++) {
      var step = t.steps[i];
      var key = stepKey(step);
      var node = list.querySelector ? list.querySelector('[data-pstep="' + key + '"]') : null;
      if (!node) {
        list.insertAdjacentHTML('beforeend', stepRowHtml(step));
        continue;
      }
      // 旁白是一次性定稿：节点在就什么都不用改（下面那些只认可折叠的 pstep 行，
      // 走进去会给她加上一个 'live' 类，还会去找不存在的 summary）。
      if (step.kind === 'say') continue;
      if (node.classList) {
        node.classList.toggle('live', step.kind !== 'tool' && !step.done);
        node.classList.toggle('running', step.kind === 'tool' && step.state === 'running');
        node.classList.toggle('bad', step.kind === 'tool' && step.state === 'error');
      }
      var sub = node.querySelector ? node.querySelector('.pstep-s') : null;
      if (sub) sub.textContent = stepSubline(step);
      // 收着的那一步看不见正文，改它就是白花 CPU（长思考时每 500ms 一次）。
      if (node.open) {
        var bodyEl = node.querySelector ? node.querySelector('.pstep-body') : null;
        if (bodyEl) {
          var text = stepBodyText(step);
          bodyEl.textContent = text;
          bodyEl.classList.toggle('empty', !text);
        }
      }
    }
    var nEl = group.querySelector ? group.querySelector('.pgroup-n') : null;
    if (nEl) nEl.textContent = t.steps.length + ' 步';
    // 抬头跟着「有没有工具步」变：先只有思考、后面才调工具的那一组，不更新就还写着「思考」。
    var kEl = group.querySelector ? group.querySelector('.pgroup-k') : null;
    if (kEl) kEl.textContent = stepsHasTool(t.steps) ? '过程' : '思考';
    var pEl = group.querySelector ? group.querySelector('.pgroup-s') : null;
    if (pEl) pEl.textContent = '· ' + stepTitle(t.steps[t.steps.length - 1]);
    if (stick) mainEl.scrollTop = mainEl.scrollHeight;
  }

  /** 按 key 找回那一步（流式那份和各条回答挂着的都要找）。 */
  function stepByKey(key) {
    var boxes = [];
    if (state.thinking) boxes.push(state.thinking);
    var ts = Object.keys(state.thoughts || {});
    for (var i = 0; i < ts.length; i++) boxes.push(state.thoughts[ts[i]]);
    for (var b = 0; b < boxes.length; b++) {
      var steps = boxes[b] && boxes[b].steps;
      if (!steps) continue;
      for (var j = 0; j < steps.length; j++) if (stepKey(steps[j]) === key) return steps[j];
    }
    return null;
  }

  /** 展开状态要跨重绘记住：原生 <details> 重画一次就回默认折叠。 */
  function onProcessToggle(e) {
    var el = e.target;
    if (!el || !el.classList) return;
    if (el.classList.contains('pgroup')) {
      thoughtGroupOpen = el.open === true;
      return;
    }
    if (!el.classList.contains('pstep')) return;
    var key = el.getAttribute('data-pstep');
    if (!key) return;
    thoughtStepOpen[key] = el.open === true;
    // **刚展开这一步时把正文补上**：收着的时候 paintProcessLive 故意不写正文
    // （看不见还改它是白花 CPU），所以这里得补一次，否则点开是空的。
    if (!el.open) return;
    var step = stepByKey(key);
    var bodyEl = el.querySelector ? el.querySelector('.pstep-body') : null;
    if (!step || !bodyEl) return;
    var text = stepBodyText(step);
    bodyEl.textContent = text;
    bodyEl.classList.toggle('empty', !text);
  }

  /** 拿到（或建出）本轮的过程清单。 */
  function processSteps() {
    if (!state.thinking) state.thinking = { steps: [], at: 0 };
    return state.thinking;
  }

  function pushProcessStep(step) {
    var box = processSteps();
    box.steps.push(step);
    while (box.steps.length > THOUGHT_KEEP) box.steps.shift();
    box.at = Date.now();
    return step;
  }

  /**
   * 一段思考的帧：`{ step, delta?, detail, done, text? }`。
   *
   * `step` 是服务端给的步号（会话内递增）。号往回走了 = 上一轮没等到回答就又想了
   * （被打断的那一轮），这时把旧清单作废，别把两轮混成一列。
   */
  function applyThoughtFrame(frame) {
    var id = typeof frame.step === 'number' ? frame.step : 1;
    var box = processSteps();
    var step = null;
    var lastId = 0;
    for (var i = 0; i < box.steps.length; i++) {
      if (box.steps[i].kind !== 'think') continue;
      if (box.steps[i].id > lastId) lastId = box.steps[i].id;
      if (box.steps[i].id === id) step = box.steps[i];
    }
    if (!step && id <= lastId) {
      state.thinking = null;
      box = processSteps();
    }
    if (!step) step = pushProcessStep({ kind: 'think', id: id, text: '', detail: '', done: false });
    if (frame.done) {
      step.done = true;
      if (typeof frame.text === 'string' && frame.text) step.text = frame.text;
    } else if (typeof frame.delta === 'string' && frame.delta) {
      step.text = (step.text + frame.delta).slice(0, THOUGHT_TEXT_MAX);
    }
    if (frame.detail) step.detail = frame.detail;
    box.at = Date.now();
    paintProcessLive();
  }

  /**
   * 步骤行的帧：`{ rows: [{ id, kind:'tool', name, summary, state, output }] }`。
   * 同一 id 后到的帧是**补丁**（结果落定），按 id 就地改那一行。
   *
   * `kind:'say'` 是旁白（2026-11-27 晚）：正文在 `text` 里，一次性定稿、没有补丁。
   * 它和工具行共用这一条帧，是因为**顺序**——模型先说话再调工具，两条帧各走各的
   * 就没法保证谁在前；同一个数组按到达顺序发，页面照着 append 就对了。
   */
  function applyStepRows(rows) {
    var box = processSteps();
    var touched = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row.id) continue;
      var say = row.kind === 'say';
      var kind = say ? 'say' : 'tool';
      var step = null;
      for (var j = 0; j < box.steps.length; j++) {
        if (box.steps[j].kind === kind && box.steps[j].id === row.id) { step = box.steps[j]; break; }
      }
      if (!step) {
        step = say
          ? pushProcessStep({ kind: 'say', id: row.id, text: row.text || '' })
          : pushProcessStep({
            kind: 'tool', id: row.id, name: row.name || '', summary: row.summary || '',
            state: row.state || 'running', output: row.output || '',
          });
      } else if (say) {
        if (row.text) step.text = row.text;
      } else {
        if (row.name) step.name = row.name;
        if (typeof row.summary === 'string') step.summary = row.summary;
        if (row.state) step.state = row.state;
        if (row.output) step.output = row.output;
      }
      touched = true;
    }
    if (touched) {
      box.at = Date.now();
      paintProcessLive();
    }
  }

  /**
   * 一条消息的 HTML。从 renderChat 的逐条循环里提出来：完整模式要把每轮的过程组
   * **穿插进这串消息的原位**（renderFull → trajInterleave），聊天模式直接按顺序拼——
   * 两边画同一条消息必须是同一段代码，两处各写一遍迟早走样。
   */
  function chatMsgHtml(m) {
    // 指令行：这是会话做的一个动作，不是谁说的话，单独一种长相——
    // 不套气泡、不给复制按钮（见 commandBlock 的说明）。
    if (m.role === 'command') return commandBlock(m);
    // 子智能体完工的通知：同一类「会话做的事」，画成一张可展开的卡片
    // （见 noticeBlock 的说明）。它没有复制按钮，也没有气泡。
    if (m.role === 'notice') return noticeBlock(m);
    // 你答过的一道题：第四种东西，画成一条 chip（见 answerBlock 的说明）。
    if (m.role === 'answer') return answerBlock(m);
    // 被按停的那一轮：标一句，别让人以为模型答到一半断了。
    var stopped = m.interrupted ? '<span class="stopped">已停止</span>' : '';
    // 两种消息都给复制按钮。自己敲的指令也常有「再发一遍」「拿去别处用」的时候，
    // 原来只给 AI 气泡，用户反馈自己的话复制不了。
    var copyBtn = '<button class="copy" type="button" aria-label="复制" title="复制"'
      + ' data-copy="' + escapeHtml(m.text) + '">' + ICON_COPY + '</button>';
    if (m.role === 'user') {
      // 自己的指令：仍然是气泡，靠右。自己敲的是纯文本，不走 markdown——
      // 不然打几个星号就变样了。
      // 长指令先折起来：露开头几行 + 一个「展开」，不让它把整屏撑满。
      var key = (state.boundSessionId || '') + '|' + (m.timestamp || 0);
      var longText = isLongUserText(m.text);
      var expanded = !!expandedUserMsgs[key];
      var body = '<div class="bubble-text'
        + (longText && !expanded ? ' clamped' : '') + '">' + linkify(m.text) + '</div>';
      var more = longText
        ? '<button class="bubble-more" type="button" data-more="' + escapeHtml(key)
          + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">'
          + (expanded ? '收起' : '展开') + '</button>'
        : '';
      return '<div class="bubble user">' + body + more
        + '<span class="meta">' + stopped + timeLabel(m.timestamp) + copyBtn + '</span></div>';
    }
    // AI 的回答：**不套气泡**（用户要求「参考单帧模式那样」）。
    // 于是一左一右、一个有框一个没框，正好分得清谁说的。
    // 徽标放正文**上面、靠左**（2026-11-27 用户要的位置）：`.said` 是块级，第一个
    // 子节点就是左上角那一行。
    return '<div class="said">'
      + (stopped ? '<div class="reply-bar">' + stopped + '</div>' : '')
      + tokenBadge(m.usage)
      + '<div class="md">' + mdToHtml(m.text) + '</div>'
      + '<div class="reply-foot">' + copyBtn
      + '<span class="time">' + timeLabel(m.timestamp) + '</span></div></div>';
  }

  /**
   * 聊天那一串的「料」：滤掉排队那条、按窗口裁好、逐条变行。
   *
   * 返回的是**结构**（行数组 + 对应消息 + 滤后全量），不是拼好的字符串——
   * renderChat 直接按顺序拼；renderFull 拼之前要把每轮的过程组插进 rows 的
   * 原位（见 trajInterleave），只有结构在手才插得动。
   *
   * searchTurns 是「搜索命中的轮号」（只在完整模式搜索时给）：命中轮的消息
   * 哪怕在窗口外也要露出来（10.3-3，「命中组在原位强开」的原位得先在场）。
   */
  function buildChat(searchTurns) {
    // 换了会话就把窗口收回首屏：上一个会话铺到多少轮都不该跟过来——那正是这次要修的慢。
    // 判据用会话 id 而不是 history 的引用：服务端每次推的都是整份新数组，比引用永远「变了」。
    if (chatTurnsFor !== state.boundSessionId) {
      chatTurnsFor = state.boundSessionId;
      chatTurns = CHAT_TURNS;
    }
    // **还在排队的那条不算「已发出」，这里要把它从聊天记录里滤掉。**
    //
    // 用户 2026-09-22 实机提的：「排队的指令在轮到之前不该出现在指令气泡里，
    // 就像发出去了一样，应该轮到再发出去。」
    //
    // 光在发送时不记账还不够。DSH 的一条排队消息可能被**领走一步、那一步又被驳回、
    // 于是退回队列**（dsh-agent 的原话：preserve queued and steering inbox items
    // instead of discarding them）。退回去的时候，早先那条「它开始跑了」的事件已经
    // 发过，聊天记录就此留下一笔——而队列里也还有它。实测抓到过同一个 id 两处都在。
    //
    // 所以判据不能是事件，得是**队列本身**：队列里有它，它就还没轮到。
    // 等它真跑起来、从队列里消失，这一笔自然就露出来了。
    var queuedIds = {};
    (state.queued || []).forEach(function (q) { if (q && q.id) queuedIds[q.id] = true; });
    // 服务端只推最近几轮，更早的是按需取回来的（见 fetchOlderChat），拼在前面用。
    // 两段的钟是同一个（服务端的 historyOldestTurn / 事件 time），不会接错。
    var source = (state.historyOlder || []).concat(state.history || []);
    var list = source.filter(function (m) {
      return !(m.role === 'user' && m.id && queuedIds[m.id]);
    });
    // 先记「本地一共有多少条」再分支：下面那条「还没有对话记录」的路也要把数记成 0，
    // 不然中途清空一次（服务端正在重读）会留着一个旧的条数，让 maybeGrowChat 白忙一场。
    chatLoaded = list.length;
    if (!list.length && !state.running && !state.live && !(state.queued || []).length) {
      // 「正在读」和「确实没有」是两件事，分开说。点开一个插件没看过的会话时，
      // 服务端要去 DSH 的会话记录里读它那一段（最大的那条 20 MB、约半秒），
      // 这期间说「还没有对话记录」会让人以为这个会话本来就是空的。
      // 轮数也一起清零：不然中途清空一次会留着旧轮数，让 maybeGrowChat 白忙一场。
      chatTotalTurns = 0;
      chatHiddenTurns = 0;
      return {
        empty: state.historyLoading
          ? '<div class="placeholder">正在读取这个会话的记录…</div>'
          : '<div class="placeholder">还没有对话记录。</div>',
        moreNote: '', rows: [], list: [], all: [],
      };
    }
    // **只铺最近 3 轮**，剩下的留在手里等用户往上滑（来由见 CHAT_TURNS 那段）。
    // 分组切在**滤掉排队那条之后**：不然被滤掉的那条会白占一个名额。
    var keys = chatTurnKeys(list);
    chatTotalTurns = countTurns(keys, keys.length);
    var older = turnWindowStart(keys, chatTurns);
    // 搜索命中轮把窗口上沿抬到自己（10.3-3）：不然命中的过程组按「组跟消息走」
    // 的规矩被裁在窗口外，搜得到、看不见。
    if (searchTurns && searchTurns.length) {
      for (var t = 0; t < list.length; t++) {
        if (list[t] && searchTurns.indexOf(String(list[t].turn)) >= 0 && t < older) {
          older = t;
          break;
        }
      }
    }
    // 「外面还压着几轮」按最终上沿重算：搜索把窗口抬高之后，提示里的数字得跟着变。
    chatHiddenTurns = countTurns(keys, older);
    var all = list;
    if (older) list = list.slice(older);
    // **刚答完的那道题**（见 rememberAnswer）：按时间插进这一串里。
    //
    // 两条讲究（2026-11-27 晚，用户实机报「卡片显示错位置、越堆越多」）：
    //   ① **不是**一律贴到最后——它有时间戳，就按时间排；否则几条旧结果会全堆在屏幕最底下，
    //      看着像「刚才答的」，其实是很早以前那道题。
    //   ② 只在这一屏的范围内顶替服务端那条：比最老一条还老就退场——窗口都翻过去了，
    //      它该等用户往上翻时由服务端那份 history 出现，不能一直挂在底下。
    if (localAnswers.length) {
      var oldestAt = list.length && list[0].timestamp ? list[0].timestamp : 0;
      for (var la = 0; la < localAnswers.length; la++) {
        var one = localAnswers[la];
        if (answerInHistory(one.items)) continue;
        if (oldestAt && one.at <= oldestAt) continue;
        var row = { role: 'answer', items: one.items, timestamp: one.at, turn: null, local: true };
        var at = 0;
        while (at < list.length && (list[at].timestamp || 0) <= row.timestamp) at++;
        list.splice(at, 0, row);
      }
    }
    // 「上面还有，往上滑」要贴在**看得到的顶上**，而且**离顶远了就收起来**——
    // 两处讲究见 .more-note 的样式注释。露 / 收在这里先按当前位置定一次，
    // 之后由滚动里的 paintChatNote 接着跟。
    // 数字说「还有几轮」：按条数说话（「还有 37 条」）没人能算出还要滑几次。
    // 本地翻完了、服务端说前面还有（historyHasMore）时就只说「往上滑取更早的」——
    // 那几段还在服务端手里，具体几轮得取回来才知道，**不编一个数**。
    var noteText = older
      ? '往上滑看更早的' + (chatHiddenTurns > 0 ? '（还有 ' + chatHiddenTurns + ' 轮）' : '')
      : (state.historyHasMore ? '往上滑取更早的' : '');
    var moreNote = (older || state.historyHasMore)
      ? '<div class="more-note' + (chatNoteVisible() ? '' : ' hide') + '">' + noteText + '</div>'
      : '';
    var rows = [];
    for (var qi = 0; qi < list.length; qi++) {
      var qm = list[qi];
      // 过程清单的定稿挂在**它那一条回答**前面（2026-11-27）：按回答的 timestamp 对号，
      // 所以翻页、重画、切回来都不会错位。流式那一份还在 live 区（见 processLiveHtml）。
      if (qm && qm.role === 'assistant' && state.thoughts && state.thoughts[qm.timestamp]) {
        var tb = processHtml(state.thoughts[qm.timestamp]);
        if (tb) rows.push(tb);
      }
      rows.push(chatMsgHtml(qm));
    }
    return { empty: null, moreNote: moreNote, rows: rows, list: list, all: all };
  }

  function renderChat() {
    mainEl.classList.remove('center');
    var built = buildChat();
    if (built.empty) {
      replyEl.innerHTML = built.empty;
      return;
    }
    // 先问「在不在底部」，再改内容——顺序反了永远是「在」（见 atBottom 的注释）。
    var stick = atBottom();
    replyEl.innerHTML = chatFrame(built, built.rows.join(''), state.live ? liveBlock(state.live) : '');
    scrollChat(stick);
  }

  /**
   * 往上滑到接近顶部，就再放一屏出来。
   *
   * 判据是「离顶部一屏的四分之一以内」，不要求真滑到 0：手机上惯性滚动会滑过头，
   * 卡在 0 反而要等一次回弹才触发。60 是下限（矮屏上四分之一太小，拇指一带就滑过），
   * 160 是上限（高屏上别放得太早，太早等于提前干了下一屏的活）。
   */
  function maybeGrowChat() {
    // 单帧模式那边也在往 main 上滚（回答落定要跳到页面顶端），别把那一下当成「他在往上翻」；
    // 本地都放完了也没什么可放的。完整模式画的也是这串聊天记录，翻页照旧要能放。
    if (state.mode === 'minimal' || chatLoaded <= 0) return;
    // 本地翻完了但服务端还有更早的，也要放行（见 growChat 的第二条路）。
    if (chatTurns >= chatTotalTurns && !state.historyHasMore) return;
    // **页面自己刚滚过去的那个位置不算「用户往上翻」**：首屏把最新回答的开头对齐到顶部
    // 时，那个位置常常就在离顶一屏以内，不挡一下就会白多铺一屏（见 chatTopOwned）。
    // 注意只挡**放屏**这一件事：装填记号照旧要按位置更新，不然放完一屏之后
    // 自己那次补偿滚动会把 chatGrowArmed 卡在 false——用户再滑到顶就再也放不出来了。
    var owned = chatTopOwned >= 0 && Math.abs(mainEl.scrollTop - chatTopOwned) <= 2;
    if (owned) chatTopOwned = -1;
    if (mainEl.scrollTop > chatEdge()) {
      // 滑下来了，这一轮重新装填：**一次靠近只放一屏**。
      // 不装填的话，万一位置校正没顶住（iOS 顶上那截橡皮筋会把人拽回 0），
      // 一次手势就能把 200 条连着放完——那正好把这个改动白做了。
      chatGrowArmed = true;
      return;
    }
    if (owned) return;
    if (!chatGrowArmed) return;
    chatGrowArmed = false;
    growChat();
  }

  /** main 每一次滚动：先对齐那句提示的露 / 收，再看要不要再放一屏。 */
  function onMainScroll() {
    paintChatNote();
    maybeGrowChat();
  }

  /**
   * 往前多放一屏。纯本地动作：那些记录本来就在页面手里，不再问服务端。
   *
   * **放完必须立刻把位置校回来**，这是整件事最容易做坏的一步：往前面插内容，
   * 浏览器不会替你补偿，用户正看着的那一屏会被整个推下去一屏。
   *
   * 补偿用「离底部多远」：这次加的东西全在顶上，底部那一截一个字没动，
   * 所以只要这个距离不变，他眼前那几行就一格都不会走。别去量「原来那条消息」的
   * 矩形来对齐——重画是整块换 innerHTML，那条消息已经不在文档里了，量不着。
   */
  function growChat() {
    // 本地手里还压着更早的轮：纯本地放一屏，瞬时（老行为）。
    if (chatHiddenTurns > 0) {
      var fromBottom = mainEl.scrollHeight - mainEl.scrollTop;
      // 一次多放 3 轮（2026-11-27 之前是 40 条，单位见 CHAT_TURNS 那段）。
      chatTurns += CHAT_TURNS;
      // 完整模式要走 render() 总分发：直画 renderChat 会把后面那块轨迹区抹掉。
      // （位置补偿和聊天同一套：轨迹区每次重画高度不变，底部那一截没动。）
      if (state.mode === 'full') render();
      else renderChat();
      mainEl.scrollTop = mainEl.scrollHeight - fromBottom;
      // 这一下也是自己滚的（见 chatTopOwned）：不记的话，紧接着那个滚动事件会被当成
      // 「用户滑到顶了」，一次手势就能连着放好几屏。
      chatTopOwned = mainEl.scrollTop;
      return;
    }
    // 本地翻完了、服务端说前面还有：回头取 3 轮（见 fetchOlderChat）。
    if (state.historyHasMore) fetchOlderChat();
  }

  /** 同一条记录的稳定身份：把取回来的更早那段拼进去时靠它去重（角色 + 时间戳 + 轮号）。 */
  function chatKey(m) {    return (m.role || '') + '|' + (m.timestamp || 0) + '|'
      + (m.turn === undefined || m.turn === null ? '' : m.turn);
  }

  /**
   * 往服务端要更早的 3 轮（2026-11-27）。
   *
   * 为什么要这条：`state` 快照现在只推最近几轮（见 store.js 的 turnWindowOf），
   * 更早的在插件手里、按需给。**取的时候要说一句「正在取」**——经隧道的时候这一下
   * 不是瞬时的，不说就跟卡住了一样。
   *
   * 三条边界：
   *   · 回来时**会话变了就丢掉**（同 historyOlder 那条理由）；
   *   · 服务和本地重复的条目按 chatKey 去重（快照可能已经把它带过来了）；
   *   · 一条都没取到 = 真的到顶了，把 historyHasMore 关掉，别再空转。
   */
  function fetchOlderChat() {
    if (state.historyFetching || !state.historyHasMore) return;
    var sessionAt = state.boundSessionId;
    var beforeTurn = state.historyOldestTurn;
    var fromBottom = mainEl.scrollHeight - mainEl.scrollTop;
    state.historyFetching = true;
    var note = moreNoteEl();
    if (note) note.textContent = '正在取更早的…';
    var q = '/mini/api/history?turns=' + CHAT_TURNS
      + (beforeTurn === null || beforeTurn === undefined
        ? '' : '&before=' + encodeURIComponent(beforeTurn));
    api(q).then(function (res) {
      state.historyFetching = false;
      if (state.boundSessionId !== sessionAt) return;
      var got = res && Array.isArray(res.history) ? res.history : [];
      if (res && 'hasMore' in res) state.historyHasMore = res.hasMore === true;
      if (res && 'oldestTurn' in res) {
        state.historyOldestTurn = res.oldestTurn === null ? null : (res.oldestTurn ?? null);
      }
      if (!got.length) {
        state.historyHasMore = false;
        renderChat();
        toast('没有更早的记录了');
        return;
      }
      var have = {};
      var i;
      for (i = 0; i < (state.historyOlder || []).length; i++) have[chatKey(state.historyOlder[i])] = true;
      for (i = 0; i < (state.history || []).length; i++) have[chatKey(state.history[i])] = true;
      var fresh = got.filter(function (m) { return !have[chatKey(m)]; });
      state.historyOlder = fresh.concat(state.historyOlder || []);
      state.historyOlderFor = sessionAt;
      // 取回来的这几轮要真的露出来，所以窗口跟着长（少于 3 轮时等于全部铺开）。
      chatTurns += CHAT_TURNS;
      if (state.mode === 'full') render();
      else renderChat();
      mainEl.scrollTop = mainEl.scrollHeight - fromBottom;
      chatTopOwned = mainEl.scrollTop;
    }).catch(function () {
      state.historyFetching = false;
      renderChat();
      toast('更早的记录没取到');
    });
  }

  /**
   * 聊天模式的滚动：**他本来在底部就跟着新内容走，翻上去看历史就不动他。**
   *
   * 2026-11-28 用户改口：回答落定不再把它的开头对齐到视野顶部。原话是「一旦 AI
   * 开始响应，就会自动弹到上面去，需要往下滑才能看到最新的对话响应」。
   *
   * 撤掉的是之前两条口径：09-24「回答出现时，页面应该停留在回答的开头而非末尾」、
   * 10-22「落定停在正文第一行」。它们和「看到最新内容」本来就互斥——回答超过一屏时，
   * 停在开头就等于看不到末尾。用户这次选了后者，所以对齐开头那条路不再从这里走。
   *
   * 现在流式与落定同一个口径，只剩一件事：
   *
   *   · `stick` 是**改 innerHTML 之前**问的（见 atBottom 的注释），答的是「他刚才在
   *     不在底部」，也就是「他是不是在跟着看」。在 → 把视野带到新内容的末尾；不在
   *     （在翻旧记录）→ 一个像素都不碰，这是 2026-09-22「别把他拽回来」那条规矩。
   *   · 流式那一路的每一帧走的是 paintLive（快路），那边同样只在底部时跟，见它。
   *
   * 单帧模式不受影响：那边落定照旧跳到页面顶端（见 renderMinimal 的 scrolledReplyAt）。
   * 「对齐开头」那套（pinToTop / firstContentLine）留着没删，理由见 pinToTop 的注释。
   */
  function scrollChat(stick) {
    if (!stick) {
      // 没滚就等于没占住任何位置，别让上次记下的那个数冒充「这是我自己滚的」。
      chatTopOwned = -1;
      return;
    }
    mainEl.scrollTop = mainEl.scrollHeight;
    // 自己滚的，记一笔（见 chatTopOwned 的说明）。
    chatTopOwned = mainEl.scrollTop;
  }

  /**
   * 三种模式各自的提示语。「完整」= 聊天那一串 **+ 每一轮的过程组**，所以三句话
   * 必须跟着模式一起改——收在一处是防两处走样（渲染处和点击处各写一遍的旧写法，
   * 加第三种模式时漏一处，用户看到的就是「点了完整、说明还写着聊天」）。
   */
  function modeHint() {
    if (state.mode === 'chat') return '聊天：常规问答对话';
    if (state.mode === 'full') return '完整：附加每一步过程';
    return '单帧：只留最新一条回复';
  }

  /**
   * 「完整」的底座：聊天那一串**全部照画**（分批、往上滑补页、滚动对齐都照旧），
   * 每一轮的过程组**穿插进它那轮对话的原位**——指令之后、回答之前（10.3-1，
   * 对齐 DSH 聊天视图的 turn-process 位置，2026-10-03 用户裁决「一定要让执行
   * 轨迹的逻辑符合DSH本身」）。三层折叠那套跟着组走，落点规则见 trajInterleave。
   * 但**「正在读取」和「没有过程」必须分清**：loading=true 是服务端还在读会话记录，
   * 不是这个会话没有过程。这期间什么都不说，人就会以为没有过程——所以那句注记
   * 照旧垫在最前面。没轨迹且不在 loading 时一个过程组都不画（这时完整模式和聊天
   * 长得一样，是预期）。
   */
  function renderFull() {
    // 换了会话，用户手动拨过的折叠开关就作废——和聊天窗 chatTurnsFor 同一个道理：
    // 两场会话的轮号会撞在一起，留在手里的开关会去拨新会话的组。
    if (trajFor !== state.boundSessionId) {
      trajFor = state.boundSessionId;
      trajGroupOpen = {};
      trajEntryOpen = {};
    }
    mainEl.classList.remove('center');
    var built = buildChat();
    var html;
    if (built.empty) {
      // 一条消息都没有（正在读/确实没有）：手里有过程组就兜底页尾（10.3-1 d）。
      // 这一路不滚动，和 renderChat 的空态同口径。
      html = built.empty + trajInterleave([], [], built.all).join('');
    } else {
      // 先问「在不在底部」，再改内容——顺序反了永远是「在」（见 atBottom 的注释）。
      var stick = atBottom();
      html = chatFrame(built, trajInterleave(built.rows, built.list, built.all).join(''),
        state.live ? liveBlock(state.live) : '');
      replyEl.innerHTML = state.trajectoryLoading
        ? '<div class="history-note">正在读取这个会话的过程…</div>' + html
        : html;
      scrollChat(stick);
      bindTraj();
      return;
    }
    if (state.trajectoryLoading) {
      html = '<div class="history-note">正在读取这个会话的过程…</div>' + html;
    }
    replyEl.innerHTML = html;
    bindTraj();
  }

  /** 轨迹区的点击走一次容器委托就够（重绘都是全新 HTML，逐个绑必漏）。 */
  function bindTraj() {
    if (trajBound) return;
    trajBound = true;
    replyEl.addEventListener('click', onTrajectoryClick);
  }

  /**
   * 聊天那串的外框：截断说明排内容前面、流式那段接在最后、moreNote 贴顶。
   * 聊天与完整两个模式共用这一段——两处各写一遍的旧写法走样过（见 modeHint 的说明）。
   * liveHtml 由调用方给（完整模式的切片里没有 liveBlock，传空串就是「没有流式」）。
   *
   * 定义在 renderFull 之后是**测试切片的约束**：trajHarness 切的是
   * renderFull → applySnapshot，外框函数得在切片里才调得到；页面里函数提升，
   * 位置不影响 renderChat 调它。
   */
  function chatFrame(built, body, liveHtml) {
    var html = body;
    // 「这不是全部」要说在**内容前面**：用户往上翻到顶时，第一眼看到的就是它，
    // 免得以为这个会话只有这么点内容。读历史有上限（见服务端 HISTORY_MAX_*）。
    if (state.historyTruncated) {
      html = '<div class="history-note">'
        + escapeHtml(state.historyNote || '这个会话很大，只显示了最近一段。')
        + '</div>' + html;
    }
    // 「正在执行」不再追加一个气泡——它是常驻的 #work，排在整串消息下面。
    // 流式那段（live）接在所有行（含穿插的过程组）之后：过程在回答之前，
    // 正在流的半句就是「回答」那个位置（10.3-1）。
    //
    // 聊天模式多一块「这一轮的过程」（2026-11-27 v2：思考 + 工具步骤，整组默认折叠）：
    // 排在 live 前面——过程在回答之前。完整模式不放：那边的轨迹组本来就有这一段，
    // 放两遍是重复。
    if (state.mode === 'chat') html += processLiveHtml();
    if (liveHtml) html += liveHtml;
    return built.moreNote + html;
  }

  // ---------------- 轨迹的折叠与长相（完整模式，对齐 PC） ----------------
  // 数据是上一棒收进 state.trajectory 的轮次组：组 {turn, state, entries[]}，
  // 条目 {kind:'think'|'tool', name, args, summary, output, state, …}，字段语义
  // 见 lib/trajectory.js 头上的说明（思考正文和工具结果都放 output）。
  // 长相对齐 DSH 桌面端的 turn-process（tasks/todo.md 11）：组头一行 = 图标 +
  // 状态词/标题（跑着是「正在…」活动词，收官是「已读取文件并调用工具」这类组合标题），
  // 条目一行 = 图标 + 「工具显示名 · 参数摘要」（思考行是「思考 · 首行」），
  // 点开才见正文（工具给「参数+结果」、思考给想的内容）。
  // 折叠口径不变：组级把「已结束的多条组」收成一行（running 还在长、error 要给人看、
  // 单条收了没信息量，这三种默认摊开）；条目级默认收。
  // 用户拨过的开关存在下面两个对象里（组按轮号、条目按 id），只在本会话内有效，
  // 换会话时在 renderFull 里清掉。
  var trajFor = null;        // 上次渲染时的会话 id（变了就清开关）
  var trajGroupOpen = {};    // 组级手动覆写：{ 轮号字符串: true|false }
  var trajEntryOpen = {};    // 条目级手动覆写：{ 条目 id: true|false }
  var trajBound = false;     // replyEl 上的委托绑过没有

  /**
   * 组默认摊不摊。收的条件是**两条一起成立**：条目够多（≥2）、已经跑完
   * （running 还在长，收了就看不见新条目；error 出错的组自己摊到条目级给人看，
   * 不用点）。用户手动拨过的开关优先于默认值。
   */
  function trajGroupIsOpen(g) {
    var key = String(g.turn);
    if (Object.prototype.hasOwnProperty.call(trajGroupOpen, key)) return trajGroupOpen[key];
    if (!g.entries || g.entries.length < 2) return true;
    if (g.state === 'running' || g.state === 'error') return true;
    return false;
  }
  /** 一条摊不摊：用户开关优先；没有开关时默认收（点开才见正文）。 */
  function trajEntryIsOpen(e) {
    if (Object.prototype.hasOwnProperty.call(trajEntryOpen, e.id)) return trajEntryOpen[e.id];
    return false;
  }

  /**
   * 组头的开关。key 是 data 属性上的字符串（getAttribute 回来一定是字符串，
   * 轮号是数字，两边统一按 String 比——有一边不转换就会拨空）。
   * 拨完立刻重画：开关唯一可见的效果就是下一次渲染，不重画等于点了没反应。
   */
  function toggleTrajGroup(turnKey) {
    var groups = state.trajectory || [];
    for (var i = 0; i < groups.length; i++) {
      if (String(groups[i].turn) !== String(turnKey)) continue;
      trajGroupOpen[turnKey] = !trajGroupIsOpen(groups[i]);
      break;
    }
    render();
  }
  // 点的当下算开还是收，要按「含搜索强制摊开」的实况来（不然搜索摊开的条目点了
  // 收不回去）：先按 id 找到那条再取反；找不到时按手里原有的开关算，和原来一致。
  function toggleTrajEntry(id) {
    var open = trajEntryOpen[id] === true;
    var groups = state.trajectory || [];
    for (var i = 0; i < groups.length; i++) {
      var es = groups[i].entries || [];
      for (var j = 0; j < es.length; j++) {
        if (String(es[j].id) === String(id)) open = trajEntryIsOpen(es[j]);
      }
    }
    trajEntryOpen[id] = !open;
    render();
  }

  /**
   * 失败首行。reason 的第一行；reason 取不到就用错误名/错误码，都没有就如实说
   * 「失败」——**不编原因**（和 lib/trajectory.js readError 同一条口径）。
   */
  function trajErrLine(e) {
    if (!e || !e.error) return '';
    var r = typeof e.error.reason === 'string' ? e.error.reason : '';
    if (!r && typeof e.error.name === 'string' && e.error.name) r = e.error.name;
    if (!r && typeof e.error.code === 'string' && e.error.code) r = e.error.code;
    if (!r) return '失败';
    return r.split('\n')[0];
  }
  /** 组头上的失败首行：组里第一条带失败身份的条目的那一行。 */
  function trajGroupErrLine(g) {
    if (!g.entries) return '';
    for (var i = 0; i < g.entries.length; i++) {
      var line = trajErrLine(g.entries[i]);
      if (line) return line;
    }
    return '';
  }

  /**
   * 截断标注。N 是**原始总字符数**（truncated 里的 chars 才是留下的那段），措辞照
   * lib/trajectory.js clipForTrajectory 的原句。服务端在正文尾部写了同一句就不再
   * 重复；没写（truncated 字段在、句子不在）就地补上——绝不静默砍尾。
   */
  function trajTruncNote(t, text) {
    if (!t || typeof t.total !== 'number') return '';
    if (String(text).indexOf('已截断') >= 0) return '';
    return '\n… 已截断，共 ' + t.total + ' 字符';
  }

  /**
   * 一条的正文（照 PC 的展开卡）：
   *   思考 = 普通 Markdown 段落（PC 的 compact 变体：13px/20px、三级灰、左缩进 22px，
   *          **不是等宽**——它是想的东西，不是机器吐的字节）；
   *   工具 = 「输入 / 输出」两栏卡（标签小字灰、正文等宽、细线分隔）——输入是美化后
   *          的 JSON（两空格，解析不了就原样），输出是结果文本，出错整段红色。
   * 自动审查被拒（照 PC）：参数不显示，只说清楚为什么没跑。
   * 截断标注照旧如实跟在后面。
   */
  function trajEntryBody(e) {
    var tr = e.truncated || {};
    if (e.kind === 'think') {
      if (!e.output) return '';
      return '<div class="traj-think">' + mdToHtml(e.output) + trajTruncLine(tr.think, e.output) + '</div>';
    }
    if (e.error && e.error.name === 'AutoReviewDeniedError' && e.error.code === 'AUTO_REVIEW_DENIED') {
      var reason = typeof e.error.reason === 'string' && e.error.reason
        ? e.error.reason : 'Auto review 未授权此次操作';
      return '<div class="traj-io"><div class="traj-io-row"><div class="traj-io-label">输出</div>'
        + '<div class="traj-io-body traj-io-err"><pre>工具未执行。原因：'
        + escapeHtml(reason) + '</pre></div></div></div>';
    }
    var rows = '';
    if (e.args) {
      rows += '<div class="traj-io-row"><div class="traj-io-label">输入</div>'
        + '<div class="traj-io-body"><pre>' + escapeHtml(trajPretty(e.args)) + '</pre>'
        + trajTruncLine(tr.args, e.args) + '</div></div>';
    }
    var outText = e.output;
    if (!outText && e.error) {
      // 照 PC 的 resultText 兜底：空内容且失败时，给一行「名字: 码」，不装作没有结果。
      outText = (e.error.name || 'Error') + (e.error.code ? ': ' + e.error.code : '');
    }
    if (outText) {
      rows += '<div class="traj-io-row"><div class="traj-io-label">输出</div>'
        + '<div class="traj-io-body' + (e.error ? ' traj-io-err' : '') + '"><pre>'
        + escapeHtml(outText) + '</pre>' + trajTruncLine(tr.output, e.output || '') + '</div></div>';
    }
    if (!rows) return '';
    return '<div class="traj-io">' + rows + '</div>';
  }

  /** 截断标注（如实）：单起一行小字。 */
  function trajTruncLine(t, text) {
    var note = trajTruncNote(t, text);
    return note ? '<div class="traj-io-note">' + escapeHtml(note.trim()) + '</div>' : '';
  }

  /** 参数按 PC 的 formatToolBody：能解析就美化 JSON（两空格），解析不了就原样。 */
  function trajPretty(raw) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (err) {
      return String(raw);
    }
  }

  // —— PC 同款词典（照抄 DSH 桌面端 0.2.0-rc.1，一个字不自创）——
  // 动作分类：dsh-client-ui-chat 的 activity()（工具名 → 动作）。
  function trajActivity(name) {
    var n = String(name || '');
    if (n === 'read') return 'read';
    if (n === 'read_image') return 'readImage';
    if (n === 'grep' || n === 'glob' || /_inspect$/.test(n)) return 'search';
    if (n === 'write') return 'write';
    if (n === 'edit' || n === 'apply_patch') return 'edit';
    if (n === 'bash' || n === 'pwsh' || n === 'exec_command' || n === 'write_stdin'
      || /^terminal_/.test(n)) return 'commands';
    if (n === 'run_code') return 'code';
    if (n === 'web_search') return 'webSearch';
    if (n === 'web_fetch') return 'webFetch';
    if (n === 'subagent' || /^subagent_/.test(n)) return 'subagents';
    if (n === 'todo_write' || n === 'create_goal' || n === 'update_goal' || n === 'get_goal') {
      return 'plan';
    }
    if (n === 'ask_user_question' || n === 'request_user_input') return 'questions';
    return 'tools';
  }
  // 动作 → 完成词 / 活动词（dsh-client-ui-chat 的 message.stepProcess.done.* 与 .* 本体）。
  var TRAJ_DONE = {
    thinking: '已完成分析', read: '已读取文件', readImage: '已读取图片', write: '已写入文件',
    search: '已搜索代码', edit: '修改了文件', commands: '执行了命令', code: '运行了代码',
    webSearch: '已搜索网页', webFetch: '已访问网页', subagents: '已协调子智能体',
    plan: '更新了计划', questions: '向用户提出了问题', tools: '已调用工具',
  };
  var TRAJ_LIVE = {
    thinking: '正在分析请求', read: '正在读取文件', readImage: '正在读取图片', write: '正在写入文件',
    search: '正在搜索代码', edit: '正在编辑文件', commands: '正在运行命令', code: '正在运行代码',
    webSearch: '正在搜索网页', webFetch: '正在访问网页', subagents: '正在协调子智能体',
    plan: '正在更新计划', questions: '等待你的操作', tools: '正在调用工具',
  };
  // 工具显示名（dsh-client-ui-tool 的 tool.title.*）。认不出名字的走变体标题，
  // 变体也没有就落「工具调用」——和 PC 的 generic 同一口径。
  var TRAJ_TOOL_TITLE = {
    read: '读取', read_image: '读取图片', write: '写入', edit: '编辑', apply_patch: '编辑',
    bash: '运行命令', pwsh: '运行命令', exec_command: '运行命令', write_stdin: '运行命令',
    grep: '搜索文件内容', glob: '查找文件', run_code: '运行代码',
    web_search: '网页搜索', web_fetch: '网页获取',
    todo_write: '更新任务清单', ask_user_question: '提问', request_user_input: '提问',
    create_goal: '创建目标', get_goal: '查看目标', update_goal: '更新目标',
    subagent: '创建子智能体', list_agents: '查看子智能体', send_message: '发送消息',
    interrupt_agent: '中断智能体', wait_agent: '等待子智能体', spawn_teammate: '创建队友',
  };
  var TRAJ_VARIANT_TITLE = {
    read: '读取', readImage: '读取', webFetch: '读取', search: '搜索',
    write: '写入', edit: '编辑', commands: '运行命令', code: '代码',
    thinking: '工具调用', tools: '工具调用',
  };
  function trajToolTitle(name) {
    var n = String(name || '');
    if (TRAJ_TOOL_TITLE[n]) return TRAJ_TOOL_TITLE[n];
    return TRAJ_VARIANT_TITLE[trajActivity(n)] || '工具调用';
  }
  // 图标：手写细线 SVG（1.5px 描边、currentColor），和全页图标同一种画法；
  // 画的是 PC 那套图标的角色（思考/读/搜/改/命令/代码/网页/子代理/计划/提问/工具）。
  var TRAJ_ICO = {
    thinking: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="9" r="5"/><path d="M9.5 18h5M10.5 21h3"/></svg>',
    read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L21 21"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg>',
    commands: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 7l5 5-5 5"/><path d="M12 17h7"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 8l-5 4 5 4"/><path d="M15 8l5 4-5 4"/></svg>',
    webSearch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c3 3 3 13 0 16c-3-3-3-13 0-16z"/></svg>',
    subagents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
    plan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7l2 2 3-3M4 17l2 2 3-3"/><path d="M12 8h8M12 18h8"/></svg>',
    questions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .8-1 1.7"/><path d="M12 16.5h.01"/></svg>',
    tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 4l1.5 4.5L18 10l-4.5 1.5L12 16l-1.5-4.5L6 10l4.5-1.5z"/></svg>',
  };
  function trajIco(kind) {
    return TRAJ_ICO[kind] || TRAJ_ICO.tools;
  }
  /** 折叠处给思考行的那一句：正文首行，压成一行、限 160 字（DSH 的行内摘要同款口径）。
      星号去掉（PC 同款：摘录是给人扫的，星号只会碍眼——5854）。 */
  function trajFirstLine(text) {
    var s = String(text == null ? '' : text).split('\n')[0].replace(/\s+/g, ' ').trim();
    s = s.replace(/\*\*/g, '');
    return s.length > 160 ? s.slice(0, 159) + '…' : s;
  }

  /**
   * 扫光的起点接「全局时钟」：页面每次整块重画都会把动画打回开头，每次都从头扫
   * 就成了频闪。带上当前时间在 1.5 秒周期里的位置（负 delay），重画之后接着
   * 上次的相位走，肉眼看不出断口。
   */
  function trajShimStyle() {
    return ' style="animation-delay:-' + ((Date.now() % 1500) / 1000).toFixed(3) + 's"';
  }
  /**
   * 收官标题：照抄 DSH 的 processTitle——工具条目按动作分类计数（多的在前，一样多按
   * 出现先后），取前三类拼完成词；两类共享「已」字时第二个去「已」用「并」连，
   * 三类用「，」连，超过三类加「等」；一条工具都没有（纯思考）落「已完成分析」。
   */
  function trajTitleOf(g) {
    var order = [];
    var count = {};
    var es = g.entries || [];
    for (var i = 0; i < es.length; i++) {
      if (!es[i] || es[i].kind !== 'tool') continue;
      var k = trajActivity(es[i].name || '');
      if (count[k] === undefined) { count[k] = 0; order.push(k); }
      count[k] += 1;
    }
    order.sort(function (a, b) { return count[b] - count[a]; });
    var labels = order.slice(0, 3).map(function (k) { return TRAJ_DONE[k]; });
    var first = labels[0];
    if (first === undefined) return { kind: 'thinking', text: TRAJ_DONE.thinking };
    if (labels[1] === undefined) return { kind: order[0], text: first };
    if (labels.length === 2) {
      var second = labels[1];
      if (first.indexOf('已') === 0 && second.indexOf('已') === 0) second = second.slice(1);
      return { kind: order[0], text: first + '并' + second };
    }
    return {
      kind: order[0],
      text: first + '，' + labels.slice(1).join('，') + (order.length > 3 ? '等' : ''),
    };
  }
  /**
   * 工具调用**正在拼的那半截参数**，压成一行给人看（2026-10-21）。
   *
   * 参数是 JSON（`{"path":"I:\\…","content":"…"}`），原样贴在标题行上是一屏噪音。
   * 这里只做两件事：**去掉键名和引号这类记号**、**留最后一截**——真正要看的是路径或命令
   * 那一段，它总在尾巴上。宁可短、宁可糙，也不要把一整坨 JSON 端给用户。
   */
  function liveToolTail(args) {
    var s = String(args || '');
    if (!s) return '';
    var tail = s
      .replace(/"[a-z_]+"\s*:\s*/gi, '')   // 键名
      .replace(/[[\]{}"]/g, '')            // 括号和引号
      .replace(/\\n/g, ' ')                // 转义换行
      .replace(/\s+/g, ' ')
      .trim();
    return tail.length > 120 ? '…' + tail.slice(-119) : tail;
  }

  /** 组头的图标与标题：跑着是活动词（正在…），收官是组合标题。 */
  function trajGroupTitle(g) {
    if (g.state === 'running') {
      var es = g.entries || [];
      var last = null;
      for (var i = es.length - 1; i >= 0; i--) {
        if (es[i] && es[i].state === 'running') { last = es[i]; break; }
      }
      // 还没有工具步在跑（正在想）就落「正在分析请求」——和 PC 的兜底同一个词。
      var kind = last && last.kind === 'tool' ? trajActivity(last.name || '') : 'thinking';
      // 活片段优先（正在想的那一句，随打字刷新，PC 的 label · detail 同款）；
      // 没有片段才退到条目自己的摘要。
      //
      // **2026-10-21 加一段**：模型正在拼工具参数时，把**半截命令**顺出来（流式开关
      // 开着才有这个数据）。优先于思考片段——因为走到工具这一步，思考已经结束了。
      var prose = '';
      if (state.liveTool && (state.liveTool.args || state.liveTool.name)) {
        kind = trajActivity(state.liveTool.name || '');
        prose = liveToolTail(state.liveTool.args);
      }
      prose = prose
        || state.trajectoryLive
        || (last && last.kind === 'think' ? trajFirstLine(last.output) : '');
      var plain = !prose && last ? (last.summary || '') : '';
      // 右边那半边是模型原话时走行内渲染：**加粗**、`代码` 要成样式，不是把记号原样贴在
      // 脸上（2026-10-06 用户报的，和 2026-09-27 气泡那回同一个根因）。
      // 工具摘要**不**走——那是命令/路径原文，一条「ls *.ts *.js」里的两个星号会被斜体
      // 规则吃掉（在真渲染器上试过），摘要就照旧只转义。
      var detail = prose ? mdInline(prose) : (plain ? escapeHtml(plain) : '');
      return { kind: kind, live: true, text: TRAJ_LIVE[kind], detailHtml: detail };
    }
    return trajTitleOf(g);
  }

  /**
   * 旁白那一段（对用户说的话，别的模式由鲸鱼娘气泡念，2026-10-04 起完整模式塞回轨迹）：
   * 照 PC 是过程里的一段正文——不带图标、不可点开，说完就摆在这儿。
   * 正文走 markdown 渲染（和回答区一个待遇：粗体、行内代码、列表都认），
   * 不是原样贴星号（同日用户顺手报的）。
   */
  function trajSayHtml(e) {
    var tr = e.truncated || {};
    return '<div class="traj-say">'
      + mdToHtml((e.output || '') + trajTruncNote(tr.output, e.output || '')) + '</div>';
  }

  /** 一行一条（PC 的成员行）：图标 +「显示名 · 摘要」，失败/进行中顶在这一行上。 */
  function trajEntryHtml(e) {
    if (e.kind === 'say') return trajSayHtml(e);
    var think = e.kind === 'think';
    var kind = think ? 'thinking' : trajActivity(e.name || '');
    var label = think ? '思考' : trajToolTitle(e.name || '');
    // 自动审查拒绝（照 PC）：行上摘要直接换成「Auto review 已拒绝」，别的都不重要了。
    var denial = e.error && e.error.name === 'AutoReviewDeniedError'
      && e.error.code === 'AUTO_REVIEW_DENIED';
    // 思考行展开后行上只留「思考」（照 PC：摘录是折叠态的预览，展开了就退场）；
    // 工具行不一样——展开后标题·摘要照旧留着（PC 的 keepContentWhenOpen）。
    var open = trajEntryIsOpen(e);
    var detail = denial ? 'Auto review 已拒绝'
      : think ? (open ? '' : trajFirstLine(e.output)) : (e.summary || '');
    // 跑着的行整行扫光（2026-10-04 用户点名：「某一行正在运行时会有一个渐变的效果
    // 闪过去」）。不跑的行一个字节不变——类名后缀为空时拼出来就是原样。
    var shim = e.state === 'running';
    var shimCls = shim ? ' traj-shimmer' : '';
    var shimSty = shim ? trajShimStyle() : '';
    // 内容段与状态段**分开**：内容段一行截断（照 PC 的折叠行——折叠行是给人扫的），
    // 出错/进行中的字样是独立的一段，不许被省略号吃掉（2026-10-04 真机返修）。
    var body = '<span class="traj-detail' + shimCls + '"' + shimSty
      + '>' + (detail ? ' · ' + escapeHtml(detail) : '') + '</span>';
    var chips = '';
    if (e.error) chips = ' · <span class="traj-err">' + escapeHtml(trajErrLine(e)) + '</span>';
    else if (e.state === 'running') chips = ' · <span class="traj-run">进行中</span>';
    var row = '<button type="button" class="traj-row" data-traj-entry="'
      + escapeHtml(e.id) + '"><span class="traj-ico">' + trajIco(kind) + '</span>'
      + '<span class="traj-name' + shimCls + '"' + shimSty + '>' + escapeHtml(label) + '</span>'
      + body + chips + '</button>';
    return '<div class="traj-entry">' + row
      + (trajEntryIsOpen(e) ? trajEntryBody(e) : '') + '</div>';
  }

  /** 一个轮次组：PC 的组头一行（图标 + 状态词/标题），摊开时下面挂条目。 */
  function trajGroupHtml(g) {
    var open = trajGroupIsOpen(g);
    var t = trajGroupTitle(g);
    // 右半边（活片段/思考原话）在来源处已经渲染好、也转义过，见 trajGroupTitle；
    // 状态词与收官标题是我们自己拼的词，这里照旧转义。
    var title = t.live
      ? '<span class="traj-run traj-shimmer"' + trajShimStyle() + '>' + escapeHtml(t.text)
        + (t.detailHtml ? ' · ' + t.detailHtml : '') + '</span>'
      : '<span class="traj-title">' + escapeHtml(t.text) + '</span>';
    // 组头只显示状态词/标题，失败信息在下方条目行里显示，不重复。
    var head = '<button type="button" class="traj-head" data-traj-group="'
      + escapeHtml(String(g.turn)) + '"><span class="traj-ico">' + trajIco(t.kind) + '</span>'
      + '<span class="traj-chev">' + (open ? '▾' : '▸') + '</span>'
      + title + '</button>';
    var entries = open && g.entries.length
      ? '<div class="traj-entries">' + g.entries.map(trajEntryHtml).join('') + '</div>'
      : '';
    return '<div class="traj-group">' + head + entries + '</div>';
  }

  /**
   * 把每轮的过程组插回它那轮对话的原位（10.3-1，对齐 DSH 的 turn-process 位置）。
   * 落点四条：
   *   a 该轮**第一个回答之前**——「指令 → 过程 → 回答」；
   *   b 该轮没有回答（跑着/失败）落该轮**簇尾**（活轮即页尾，新步骤从这里冒出来）；
   *   c 该轮有消息但都不在窗口里 → **不画**（组跟消息走，翻页上来自然带进来）；
   *   d 该轮一条消息都没有（排队被滤掉、本地回显没号）→ 兜底**页尾**。
   * rows[i] 与 list[i] 一一对应（list＝裁好窗的消息，all＝滤掉排队后的全量）。
   * 返回插好之后的新数组，不动入参。
   */

  function trajInterleave(rows, list, all) {
    var groups = (state.trajectory || []).filter(function (g) {
      // 空组也可能是「正在想」的那一轮：turn/start 刚到、条目要等这一步说完才落
      // （DSH 的事件就是这么给的）。它就是进展本身，不许因为还没条目就整组不画——
      // 真机上那正是「跑的时候一片安静、跑完一次性全冒出来」的观感
      // （2026-10-04 用户报的）。跑完还是空的才不画：那一组确实没有过程。
      return g && Array.isArray(g.entries) && (g.entries.length > 0 || g.state === 'running');
    });
    // 服务端那句「这不是全部」跟着轨迹内容走（11.1-C）：排在第一个过程组前面；
    // 一个过程组都没有（含轨迹读不到那条路）就兜底页尾——话必须说，位置不抢戏。
    var noteHtml = trajNoticeHtml();
    if (!groups.length) return rows.slice().concat(noteHtml ? [noteHtml] : []);
    /**
     * 已经加载到的最早一轮（下界）。服务端现在只推最近几轮（见 historyTurns），
     * **比它更早的轮还没取回来**——那些轮的过程组如果走下面那条「窗口里没有这一轮
     * 的消息 → 兜底页尾」的路，就会被一整堆塞到最新回答下面，看着像过程跑到未来去了。
     * 所以先记一条下界，比它早的组直接不画（等用户滑上去把那一轮取回来，它自然出现）。
     */
    var oldestTurn = null;
    for (var q0 = 0; q0 < list.length; q0++) {
      if (list[q0] && typeof list[q0].turn === 'number') { oldestTurn = list[q0].turn; break; }
    }
    var slots = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var at = -1;
      // a：该轮第一个回答之前
      for (var j = 0; j < list.length && at < 0; j++) {
        if (list[j] && list[j].role === 'assistant' && sameTurn(list[j].turn, g.turn)) at = j;
      }
      // b：没有回答就落簇尾
      if (at < 0) {
        for (var k = list.length - 1; k >= 0; k--) {
          if (list[k] && sameTurn(list[k].turn, g.turn)) { at = k + 1; break; }
        }
      }
      if (at < 0) {
        // 比已加载的最早一轮还早：消息还没取回来（不是「这一轮没有消息」），不画。
        if (oldestTurn !== null && typeof g.turn === 'number' && g.turn < oldestTurn) continue;
        // c/d：窗口里没有这一轮的消息——全量里有＝出窗不画；没有＝兜底页尾。
        var anywhere = false;
        for (var n = 0; n < (all || []).length; n++) {
          if (all[n] && sameTurn(all[n].turn, g.turn)) { anywhere = true; break; }
        }
        if (anywhere) continue;
        at = list.length;
      }
      slots.push({ at: at, turn: g.turn, html: trajGroupHtml(g) });
    }
    // 同一落点上的组按轮号排（兜底页尾时可能好几组），插的时候按落点从前往后放。
    slots.sort(function (x, y) { return x.at - y.at || x.turn - y.turn; });
    var out = [];
    var s = 0;
    var noted = false;
    for (var p = 0; p <= rows.length; p++) {
      while (s < slots.length && slots[s].at === p) {
        if (noteHtml && !noted) { out.push(noteHtml); noted = true; }
        out.push(slots[s++].html);
      }
      if (p < rows.length) out.push(rows[p]);
    }
    if (noteHtml && !noted) out.push(noteHtml);
    return out;
  }
  /** 轮号对得上吗：两边都要有号，再比字符串（号来自消息字段/组字段，类型不总一致）。 */
  function sameTurn(a, b) {
    return a != null && b != null && String(a) === String(b);
  }

  /**
   * 服务端「这份轨迹不是全部」的说明（state.trajectoryNote / trajectoryTruncated）。
   * 给了原句就原样显示；只有截断标志没给句子时补一句大实话兜底。**存在才显示**——
   * 一个字都没有时不许占地方，完整模式的观感必须和聊天一致。轨迹空了但服务端留了
   * 话（读取失败那条路）也要说：「读不到」不等于「没有过程」。
   */
  function trajNoticeHtml() {
    if (state.trajectoryNote) {
      return '<div class="traj-note">' + escapeHtml(state.trajectoryNote) + '</div>';
    }
    if (state.trajectoryTruncated) return '<div class="traj-note">这份轨迹不是全部。</div>';
    return '';
  }

  // 轨迹区的点击全走这一根委托。先认条目再认组头——行和头各带各的 data 属性，
  // 认错一个就拨错层。
  function onTrajectoryClick(e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var row = t.closest('[data-traj-entry]');
    if (row) { toggleTrajEntry(row.getAttribute('data-traj-entry')); return; }
    var head = t.closest('[data-traj-group]');
    if (head) toggleTrajGroup(head.getAttribute('data-traj-group'));
  }

  /**
   * 「回到底部」那颗浮标的露 / 收。
   *
   * 判据直接用 atBottom()，不另设一个数。这样有个好处：**浮标出现的那一刻，正好
   * 就是页面停止自动跟随的那一刻**——两处要是各用各的容差（比如浮标 25px、跟随 48px），
   * 中间那段就会出现「浮标说没到底、页面却自己在往下滚」这种自相矛盾的样子。
   * 电脑端那颗用的是它自己的 25px 容差（useChatReading 里的 useScrollFollow(_, 25)），
   * 这里跟的是本页既有的 48px，因为本页的黏底判据就是它。
   *
   * **单帧模式下一律不出现**（用户 2026-10-08 要求）。那一模式整屏只留最新一条回答，
   * 回答落定的那一刻页面**故意**把它的开头对齐到顶部（见 renderMinimal 里
   * scrolledReplyAt 那一段），好让人从第一行读起。所以那儿「不在底部」是设计如此，
   * **不是「用户翻上去了」**——这时候挂一颗「回到底部」，等于劝用户把刚对齐好的
   * 开头再滚掉，正好把这个模式唯一要做的事抵消掉。
   * 聊天 / 完整是多帧（一串历史一条条往上排），那里不在底部就是用户自己翻上去的，
   * 照旧出现。所以这条判的是**模式**（state.mode），不是新设一个「离底多少像素」。
   *
   * 只改 hidden，**不碰任何位置和尺寸**：位置全在 CSS 的 sticky 里算好了（见样式表）。
   * 每次现取元素、取不到就静静退出——页面测试会把 render 那一段单独抠出来跑，
   * 那里给的 $ 是替身，不能假设它一定认得这个 id。
   */
  function paintToBottom() {
    var el = $('toBottom');
    if (!el) return;
    el.hidden = atBottom() || state.mode === 'minimal';
    // 正文还在流：给圆外挂一圈流光（只是状态指示，不改显隐、不改位置）。
    // 页面测试里的替身不一定有 classList，取不到就静静跳过。
    if (el.classList && el.classList.toggle) {
      el.classList.toggle('streaming', Boolean(state.live) && state.mode !== 'minimal');
    }
  }

  function render() {
    $('hintMode').textContent = modeHint();
      if (state.mode === 'full') renderFull(); else if (state.mode === 'chat') renderChat(); else renderMinimal();
    // 装饰收放（11.1-B + 2026-11-27 的鲸鱼娘开关）：给常驻的 #work 挂 bare，
    // 立绘、气泡、光流进度条由 CSS 藏掉，只留「已 N 秒 / 停止」。两种情况都收：
    // ①「完整」模式（那一屏由轨迹自己逐条冒，再挂一只跑动的她是重复）；
    // ②用户在设置里关了鲸鱼娘（默认就是关）。#work 不跟着 #reply 重画，
    // 所以挂在总分发这里：切模式、拨开关都走 render()，各归各位。
    $('work').className = 'work' + (state.mode === 'full' || !state.pet ? ' bare' : '');
    // 重画之后滚动位置可能被浏览器夹回来（内容变短）——那种情况不一定发 scroll 事件，
    // 所以浮标的状态也在这里跟一次。放在最后：上面几句可能刚动过 scrollTop。
    paintToBottom();
  }

  /**
   * 只重画「正在流」那一块，不重画整串聊天（2026-10-22 真机）。
   *
   * 为什么非拆不可：正文每 60 毫秒来一帧，原来每一帧都走完整 `render()` ——手机要把
   * 整串历史重新拼一遍 HTML、重新算布局。主线程一旦跟不上，用户只看得见开头几帧，
   * 后面的字还在队列里排队；等落定的 `reply` 一到，整段回答一次性替换上来——看起来
   * 就是「流了一下，内容消失，然后全文蹦出来」。
   *
   * 这里只换 `.live .md` 的 innerHTML。第一次还没有 `.live` 时仍走完整 render（那一趟
   * 负责把块建出来并滚到它开头）；之后每帧都只碰这一小块。清空/落定/换模式仍走完整
   * render，别让这条快路把别的状态带偏。
   */
  function paintLive() {
    var md = replyEl.querySelector ? replyEl.querySelector('.live .md') : null;
    if (!md) { render(); return; }
    // 流式每帧也要跟着往下走（2026-11-28）：不跟的话新字一冒出来就在屏幕外，
    // 用户看到的是「字动了几下就不动了，得往下滑才看得到后面」。
    // 但**只在本来就在底部时跟**（和 renderMinimal / paintProcessLive 同一条规矩）：
    // 他翻上去看历史的时候，一秒好几帧不能把他拽回来。
    // atBottom 必须在改 innerHTML **之前**问——改完内容就永远答「在」（见它的注释）。
    var stick = atBottom();
    md.innerHTML = mdToHtml(state.live || '');
    if (stick) mainEl.scrollTop = mainEl.scrollHeight;
  }

  /**
   * 只改流式那一块里的 token 徽标（2026-11-27）。
   *
   * 和 paintLive 同一条理由：服务端一秒一帧，整串重拼一遍不值得。**只写 textContent**，
   * 不碰 innerHTML——那块正被 paintLive 用着，两边谁也别重建谁。
   *
   * 徽标可能还不存在：流式块先画出来、用量帧后到（重连时就是这样）。这时**补一枚进去**，
   * 而不是整块重画——重画会把刚流出来的正文和滚动位置一起丢掉。
   */
  function paintTokens() {
    var live = replyEl.querySelector ? replyEl.querySelector('.live') : null;
    if (!live) return;
    var u = state.usage;
    var el = live.querySelector('.tok');
    if (!u || typeof u.total !== 'number' || !(u.total > 0)) {
      if (el) el.style.display = 'none';
      return;
    }
    if (!el) {
      el = document.createElement('span');
      el.className = 'tok';
      live.insertBefore(el, live.firstChild);
    }
    el.style.display = '';
    if (u.estimated === true) el.setAttribute('data-est', '1');
    else el.removeAttribute('data-est');
    el.textContent = (u.estimated === true ? '≈' : '') + tokShort(u.total) + ' tok';
    el.title = tokTitle(u);
  }

  function applySnapshot(snap) {
    if (!snap) return;
    if ('latest' in snap) state.latest = snap.latest;
    // 正在流出来的那一段。服务端只在自己决定要显示之后才写它，所以这里是空字符串
    // 不代表模型没在写，只代表「还不到显示的时候」。
    //
    // **2026-10-21 加一个前提**：流式开关开着时，这一段由 `trajectory-live` 的增量自己拼
    // （见那个 `kind: 'text'` 分支），快照里那个 `live` 是另一套东西（服务端按整段写的），
    // 照旧覆盖会把刚拼上去的字清掉、只剩最后一小截。落定由 `trajectory` 帧负责清，不靠这里。
    if ('live' in snap && !state.streaming && !state.streamReceived) state.live = snap.live || '';
    // 模型此刻的自言自语（鲸鱼娘的台词）。null = 这会儿没话说，气泡回到该姿势自己的词条。
    if ('thought' in snap) state.thought = snap.thought || null;
    if (snap.history) state.history = snap.history;
    // 「前面还有更早的轮」+ 这次给到的最早轮号（服务端按轮裁过，见 store.js）。
    // 老服务端不发这两个字段 → 保持 false，页面就只在本地有的那几段里翻，行为不变。
    if ('historyHasMore' in snap) state.historyHasMore = snap.historyHasMore === true;
    if ('historyOldestTurn' in snap) state.historyOldestTurn = snap.historyOldestTurn === null ? null : (snap.historyOldestTurn ?? null);
    // 「服务端正去读这个会话的完整记录」。点开一个没看过的会话时，那一串要读一会儿
    // 才补上来（最大的那条日志 20 MB、约半秒），这期间不能装作「这个会话是空的」。
    state.historyLoading = snap.historyLoading === true;
    // 「这份历史只到最近一段」。服务端读历史有上限（会话太大只读日志尾部），
    // 所以内容可能是截断的——**这件事必须跟着内容一起传上来**，不能只在服务端知道。
    state.historyTruncated = snap.historyTruncated === true;
    state.historyNote = snap.historyNote || '';
    if (snap.sessions) state.sessions = snap.sessions;
    if (Array.isArray(snap.queued)) state.queued = snap.queued;
    if ('boundSessionId' in snap) {
      var wasBound = state.boundSessionId;
      state.boundSessionId = snap.boundSessionId;
      if (state.boundSessionId !== wasBound) {
        saCache = null;
        saCacheSession = null;
        saCacheAt = 0;
      }
      // 手里那份轨迹属于上一个会话——换会话立刻作废：两场会话的轮号会撞在一起，
      // 不清掉就会把新会话的过程贴到旧会话那一组上。完整模式下再拉一份新的。
      if (state.boundSessionId !== wasBound) {
        state.trajectory = [];
        state.trajectorySeq = 0;
        if (state.mode === 'full') requestTrajectory();
      }
      // 按需取回来的那段「更早的历史」也属于上一个会话，一起作废（同一条理由：
      // 时间戳和轮号都会撞）。正在飞的那个请求回来时会自己发现会话变了、丢掉结果。
      if (state.boundSessionId !== wasBound) {
        state.historyOlder = [];
        state.historyOlderFor = null;
        state.historyFetching = false;
        // 思考是「这个会话这一段回答」的，换了会话立刻作废（同 historyOlder 的理由）。
        state.thinking = null;
        // 流式那份用量读数同理：它属于上一个会话正在跑的那一轮（2026-11-27）。
        state.usage = null;
        state.thoughts = Object.create(null);
        // 刚答完那几条结果也属于上一个会话：不过去。留着的话，它会被画到新会话的最后一条
        // 后面——而那道题根本不是在这个会话里问的（同一道题可能在每个会话都长得一样）。
        localAnswers = [];
        // 展开状态是按步骤 key 记的，换会话后 key 可能撞上（步号从 1 重数），一起清掉。
        thoughtGroupOpen = false;
        thoughtStepOpen = {};
        // 这两个字段这一帧已经按快照写过了（见上面那两行）。只有**老服务端不带它们**时
        // 才清空——不带就说明这份快照没有「前面还有」的信息，留着上一个会话的值会骗人。
        if (!('historyHasMore' in snap)) state.historyHasMore = false;
        if (!('historyOldestTurn' in snap)) state.historyOldestTurn = null;
        // **不在这里碰 chatTurns / chatTopOwned**：那两样是聊天分页自己的账，换会话时
        // 由 buildChat 的 chatTurnsFor 判据收回首屏（见那里）。写在这儿还有第二个坏处：
        // page.test.mjs 的 snapshotHarness 只切 applySnapshot 这一段，会引用到切片外的变量。
      }
      // 换了会话，指令菜单那份缓存就作废了（指令表是每个会话一份的，这个会话没在跑
      // 时一条都读不到，见「斜杠指令」那一段）。重画一次，它自己会发现数据不属于
      // 这个会话、去重取——否则用户点到的是上一个会话的指令，点下去必然被拒。
      if (state.boundSessionId !== wasBound) paintCmdMenu();
      // 权限档位也是每个会话各一份的（宿主的 currentValue 读的是这个会话那份投影）。
      // 不重读的话，抽屉里显示的是上一个会话那一档——用户看到的就是一句假话。
      if (state.boundSessionId !== wasBound) loadPermissions(state.boundSessionId);
    }
    // running 也在快照里，而且算的是**当前绑定的那个会话**。不接的话，
    // 在导航栏切到别的会话时，那个会话会继承上一个会话的「正在执行」。
    if ('running' in snap) setRunning(snap.running);
    if ('subagentsRunning' in snap) {
      state.subagentsRunning = snap.subagentsRunning === true;
      $('btnSubagents').classList.toggle('subagent-running', state.subagentsRunning);
      $('btnSubagents').setAttribute('aria-label', state.subagentsRunning ? '子智能体（运行中）' : '子智能体');
    }
    paintNavCurrent();
    render();
  }

  // ---------------- 左侧导航栏 ----------------
  // 数据分两层取：先列工作区（便宜），展开某个再去要它的会话（要读日志折标题，贵）。
  // 本机实测 35 个工作区、最多的一个有 452 个会话，一次全拉会卡住手机。
  var navList = null;      // 工作区列表，开一次取一次
  var navSessions = {};    // workspaceId -> { sessions, total, truncated }
  var navFollowTimers = {}; // workspaceId -> 当前标题补齐轮询定时器
  var navExpanded = {};    // workspaceId -> 是否展开
  var navWsFetching = {};  // workspaceId -> 会话列表请求在途（同一工作区只发一趟）
  var navPresets = null;   // Agent 模式清单（2026-10-04：新建会话时手机上也要能选模式）
  var navPresetsLoaded = false;
  var navPickerWs = '';    // 正在挑模式的那个工作区（清单行内展开在它的「新建会话」下）
  // —— 会话条目的执行功能（2026-10-09）——
  /**
   * 「显示已归档」这枚筛选开关**摆在界面外**：用户 2026-10-09 要求——这个功能不需要，
   * 但既然做了，先别删、隐藏起来。
   *
   * 所以下面这一整套**一行都没删**，只是不再画到界面上：开关的渲染（renderNav 里
   * 那一段还在）、navShowArchived 这个状态、setShowArchived、拼请求时的 archived=1、
   * 服务端那条筛选口径、以及相关测试。
   *
   * **要恢复这个开关：把这一行的 false 改成 true 就行**，别的地方一处都不用动。
   */
  var SHOW_ARCHIVED_FILTER = false;
  /**
   * 「另有 N 条已归档、M 条还是空白的新会话」这句**也不摆到界面上**：
   * 用户 2026-10-09 要求——这句不需要显示，先不删、隐藏起来。
   *
   * 所以那句话的渲染、以及支撑它的两个数（hiddenArchived / hiddenBlank，服务端照旧在算、
   * 照旧随列表一起回来）**一行都没删**，只是不再画出来。
   * 注意闸住的**只是这半句**：同一块里前面那句「这个工作区里没有能列出来的会话。」
   * 照旧摆着——那是"会话全被筛掉了"这个情形的兜底文字，一起藏掉的话，
   * 工作区标题下面就是一片空白，用户会以为界面坏了。
   *
   * **要恢复这句话：把下面这一行的 false 改成 true 就行**，别的地方一处都不用动。
   */
  var SHOW_NAV_COUNT_HINT = false;
  var navShowArchived = false; // 筛选：默认**隐藏已归档**（官方默认项就是这个）
  var navActing = '';      // 正在行内展开动作条的那条会话 id
  var navRenaming = '';    // 正在改名字的那条会话 id
  var navConfirm = null;   // 归档确认：{ sessionId, title, activity }；非空就是弹着
  var navExtra = {};       // workspaceId -> 已经点了几次「展开其余」
  var navLimit = {};       // workspaceId -> 这次向服务端要了多少条（要更多时递增）

  /**
   * 「展开其余」一次多几条。**这个 5 是官方口径**，不是我们挑的：
   * PC 侧栏的文档原话是「默认只显示 5 条空闲 Session……每次点击『展开其余』最多再显示五条」。
   * 正在跑的会话不占这 5 条配额，始终显示——同一个来源。
   */
  var NAV_IDLE_QUOTA = 5;
  /** 一次向服务端要多少条。要少了「展开其余」很快就没得展开；要多了标题那一步很贵。 */
  var NAV_PAGE = 20;

  function openNav() {
    $('nav').classList.add('open');
    loadWorkspaces(false);
  }
  function closeNav() { $('nav').classList.remove('open'); }

  function loadWorkspaces(force) {
    if (navList && !force) { renderNav(); return; }
    if (!force && navPrefetchPromise) {
      $('navBody').innerHTML = '<div class="placeholder">正在读取…</div>';
      navPrefetchPromise.then(function () {
        if ($('nav').classList.contains('open')) renderNav();
      }).catch(function (err) {
        navList = null;
        $('navBody').innerHTML = '<div class="placeholder">读不到会话列表：'
          + escapeHtml(err.message) + '</div>';
      });
      return;
    }
    $('navBody').innerHTML = '<div class="placeholder">正在读取…</div>';
    // 带 refresh=1 是给 ⟳ 用的：绕过服务端的短时缓存，真去读一遍。
    // 不带的话服务端会把最近一次的结果直接给你，导航栏就不再「每次都要重新读取」。
    api('/mini/api/workspaces' + (force ? '?refresh=1' : '')).then(function (body) {
      navList = body.workspaces || [];
      navSessions = {};
      renderNav();
    }).catch(function (err) {
      navList = null;
      $('navBody').innerHTML = '<div class="placeholder">读不到会话列表：'
        + escapeHtml(err.message) + '</div>';
    });
  }

  // 导航栏不是首屏内容，但用户通常会在连上手机后很快点左上角。
  // 趁页面空闲先取一次；真正打开菜单时若已完成就直接画，不再把等待放在点击之后。
  var navPrefetchPromise = null;
  function prefetchWorkspaces() {
    // Agent 模式清单也是导航栏要用的、也几乎不变——顺手一起预取（见 prefetchPresets）。
    prefetchPresets();
    if (navList || navPrefetchPromise || navView !== 'tree' || !state.entered) return;
    var run = function () {
      navPrefetchPromise = api('/mini/api/workspaces').then(function (body) {
        navList = body.workspaces || [];
        navSessions = {};
        if ($('nav').classList.contains('open')) renderNav();
      }).finally(function () { navPrefetchPromise = null; });
      navPrefetchPromise.catch(function () {
        // 预取失败不改变导航栏原来的行为，用户打开时仍会再试一次。
      });
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 1200 });
    } else {
      setTimeout(run, 0);
    }
  }

  /**
   * Agent 模式清单（2026-10-04 用户要求：新建会话时手机上也要能选模式，PC 一直可以）。
   * 只取一次；读不到就如实记「没有可选的」——建会话那条路会直接建默认，
   * **不摆一个只有一项的选择题**，也不假装自己知道 DSH 有哪些模式。
   */
  function prefetchPresets() {
    if (navPresetsLoaded || !state.entered) return;
    navPresetsLoaded = true;
    api('/mini/api/agent-presets').then(function (body) {
      navPresets = body && body.ok ? body : { ok: false, reason: (body && body.reason) || 'failed' };
      if (navPickerWs && $('nav').classList.contains('open')) renderNav();
    }).catch(function () {
      navPresets = { ok: false, reason: 'failed' };
    });
  }

  function dayLabel(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return timeLabel(ts);
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '/' + d.getDate();
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function renderNav() {
    // 目录浏览那一屏接管整个面板。它自己画返回按钮，所以不走下面这套。
    if (navView === 'browse') { renderBrowse(); return; }
    // 自愈：navigation-refresh（会话开跑/收工都会广播）清得掉数据、清不掉展开态，
    // 重画出来的就是永远停着的「正在读取…」——取列表的请求原来只在点击时发，
    // 没人补发就一直停着（真机报过：收起再展开才好，2026-10-03）。缺数据的补拉一次，
    // loadWsSessions 自带在途闩，重复调用不会发第二趟。
    Object.keys(navExpanded).forEach(function (id) { loadWsSessions(id); });
    var list = navList || [];
    // 「新建工作区」常驻在最上面：它是这一屏的入口，不该等有了会话才出现——
    // 一个工作区都还没有的人，恰恰最需要它。
    var cta = '<button class="nav-cta" type="button" data-new-ws="1">＋ 新建工作区</button>';
    // 「显示已归档」是**整屏一个**的口径，所以放在 CTA 下面、工作区上面：
    // 它管的不是某一个工作区，是所有工作区里"已归档的那些要不要出现"。
    // 默认关（官方的默认项就是"隐藏已归档"）。
    //
    // 整块由 SHOW_ARCHIVED_FILTER 闸住（见那个常量上的说明）：闸住时这一段一个字都不画，
    // **但渲染代码原样留着**——恢复就是改那一个词，不用重写。
    var filter = SHOW_ARCHIVED_FILTER
      ? '<button class="nav-filter' + (navShowArchived ? ' on' : '')
        + '" type="button" data-archived-toggle="1" aria-pressed="' + (navShowArchived ? 'true' : 'false')
        + '">' + (navShowArchived ? '✓ ' : '')
        + (navShowArchived ? '显示已归档（点一下收起来）' : '显示已归档') + '</button>'
      : '';
    if (!list.length) {
      $('navBody').innerHTML = cta + filter + '<div class="placeholder">电脑上还没有可以切换的会话。<br>'
        + '在电脑上开一个，这里就会出现了。</div>';
      return;
    }
    $('navBody').innerHTML = cta + filter + list.map(function (ws) {
      var open = Boolean(navExpanded[ws.id]);
      return '<div class="ws' + (open ? ' open' : '') + '" data-ws="' + escapeHtml(ws.id) + '">'
        + '<button class="ws-head" type="button">'
        + '<span class="caret">▶</span>'
        + '<span class="ws-title">' + escapeHtml(ws.title) + '</span>'
        + (ws.running ? '<span class="s-dot"></span>' : '')
        // 空工作区（通常是刚在手机上建的那个）不写「0」，写「还没有会话」：
        // 一个孤零零的 0 看着像出了错，说清楚反而让人知道下一步该干什么。
        + '<span class="ws-count">' + (ws.count || (ws.empty ? '新' : 0)) + '</span>'
        + '</button>'
        + '<div class="ws-body">' + (open ? sessionsHtml(ws.id) : '') + '</div>'
        + '</div>';
    }).join('');
  }

  /** 这个工作区现在到底该摆出哪几条。**口径都在这里，一处说了算。** */
  function navVisible(wsId, got) {
    var ex = navExtra[wsId] || 0;
    var quota = NAV_IDLE_QUOTA * (ex + 1);
    var rows = [];
    var idleShown = 0;
    var idleTotal = 0;
    (got.sessions || []).forEach(function (s) {
      if (s.running === true) { rows.push(s); return; }
      idleTotal += 1;
      if (idleShown < quota) { rows.push(s); idleShown += 1; }
    });
    var remaining = Math.max(0, idleTotal - idleShown);
    return {
      rows: rows,
      quota: quota,
      // 页里还有没摆出来的，或者服务端说这个工作区还有没取回来的——两种都算"还有"
      more: remaining > 0 || got.truncated === true,
      remaining: remaining,
      expandable: remaining > 0 || got.truncated === true,
      // 按钮上那个数：官方口径是"每次最多再显示五条"，所以最多写 5。
      step: remaining > 0 ? Math.min(NAV_IDLE_QUOTA, remaining) : NAV_IDLE_QUOTA,
      collapsed: ex > 0 && !(remaining > 0 || got.truncated === true),
    };
  }

  /** 一条会话在行尾该显示什么。**一行只显示一个**：尾部那块地方只够一样。 */
  function navTail(s) {
    if (s.pending === 'approval') return '<span class="s-flag pending">待审批</span>';
    if (s.pending === 'plan') return '<span class="s-flag pending">计划待审</span>';
    if (s.pending === 'question') return '<span class="s-flag pending">待回答</span>';
    var badge = '';
    if (s.archived) badge = '<span class="s-flag">已归档</span>';
    else if (s.pinned) badge = '<span class="s-flag">已置顶</span>';
    return badge + '<span class="s-meta">' + dayLabel(s.createdAt) + '</span>';
  }

  /**
   * 动作条。**归档行不给置顶**——官方规定归档与置顶互斥（归档会把置顶一并丢掉），
   * 摆一个按了会被拒的按钮，比不摆更糟。
   *
   * 顺序照电脑端的槽位号摆（2026-10-09 从 0.2.0-rc.2 的 `dsh-client-ui-workspace` 读到原文）：
   * `sidebar.workspaces.session.menu.item` 上 pin=order 100、rename=200、**fork=300**、
   * archive=400。手机这一条横排也是一样的先后，用户从电脑换到手机上不用重新找。
   *
   * 分叉这一项**归档行也留着**：官方的菜单项没有"归档就不给分叉"这条判断
   * （只有 pin 那一个在归档行上返回 null），而且分叉出来的是一条独立的新会话。
   */
  function navActs(s) {
    var id = escapeHtml(s.id);
    var pin = s.archived
      ? ''
      : '<button type="button" data-act="pin" data-act-id="' + id + '" data-act-on="'
        + (s.pinned ? '1' : '0') + '">' + (s.pinned ? '取消置顶' : '置顶会话') + '</button>';
    var arc = s.archived
      ? '<button type="button" data-act="unarchive" data-act-id="' + id + '">取消归档</button>'
      : '<button type="button" class="danger" data-act="archive" data-act-id="' + id + '">归档会话</button>';
    return '<div class="sess-acts">'
      + pin
      + '<button type="button" data-act="rename" data-act-id="' + id + '">重命名</button>'
      + '<button type="button" data-act="fork" data-act-id="' + id + '">分叉会话</button>'
      + arc
      + '</div>'
      // 「分叉」是个电脑词，非技术用户看不出它会干什么。这句是**极短的说明**：
      // 只说两件事——从哪儿分（最近完成的一轮）、原会话会怎样（不动）。
      // 不加的话，用户能猜到的只有"分叉"两个字，而按下去是**在电脑上真建一个会话**，
      // 不是可以随便试的手势，所以这笔字值得花。
      + '<div class="sess-acts-hint">分叉＝从最近完成的一轮复制出一个新会话，原来这条不动。</div>';
  }

  function sessionsHtml(wsId) {
    // 「新建会话」永远排在最上面：不管这个工作区有几个会话、甚至一个都没有，
    // 这一行都在。放在列表末尾的话，一个 452 条会话的工作区要划到底才看得到。
    var html = '<button class="ws-new" type="button" data-newws="' + escapeHtml(wsId) + '">'
      + '＋ 新建会话</button>';
    // 模式清单（2026-10-04）：多于一种模式时，「新建会话」先把清单行内展开，
    // 点谁建谁；坏档如实标「不可用」——不装作能点。
    if (navPickerWs === wsId && navPresets && navPresets.ok && navPresets.presets.length > 1) {
      html += '<div class="ws-modes">' + navPresets.presets.map(function (m) {
        var title = '<b>' + escapeHtml(m.name || m.id) + '</b>';
        var desc = m.description
          ? '<span class="ws-mode-desc">' + escapeHtml(m.description) + '</span>' : '';
        var def = navPresets.defaultId === m.id ? '<span class="ws-mode-def">默认</span>' : '';
        if (m.broken) {
          return '<div class="ws-mode ws-mode-broken">' + title
            + '<span class="ws-mode-desc">不可用：' + escapeHtml(m.broken) + '</span></div>';
        }
        return '<button class="ws-mode" type="button" data-mode-ws="' + escapeHtml(wsId)
          + '" data-mode-preset="' + escapeHtml(m.id) + '">' + title + desc + def + '</button>';
      }).join('') + '</div>';
    }
    var got = navSessions[wsId];
    if (!got) return html + '<div class="placeholder">正在读取…</div>';
    if (!got.sessions.length) {
      // 「一条都没有」和「都被筛掉了」是两件事，得分开说——不然用户会以为
      // 自己的会话不见了（就在刚才，那还是他亲手归档的）。
      var hid = (got.hiddenArchived || 0) + (got.hiddenBlank || 0);
      if (hid > 0) {
        // 后半句（那两条条数）由 SHOW_NAV_COUNT_HINT 闸住（见那个常量上的说明）：
        // 闸住时只少这半句，**前面那句兜底照旧画**——全都不画就成了工作区标题下面
        // 一片空白，用户只会以为界面坏了。恢复就是改那一个词。
        var hint = SHOW_NAV_COUNT_HINT
          ? '<br>另有 ' + (got.hiddenArchived || 0) + ' 条已归档、'
            + (got.hiddenBlank || 0) + ' 条还是空白的新会话。'
          : '';
        return html + '<div class="placeholder">这个工作区里没有能列出来的会话。'
          + hint + '</div>';
      }
      return html + '<div class="placeholder">这个工作区还没有会话。</div>';
    }
    var cur = state.boundSessionId;
    var view = navVisible(wsId, got);
    html += view.rows.map(function (s) {
      var cls = 'sess';
      if (s.id === cur) cls += ' cur';
      // 已归档的行置灰，而且**点不开**——官方原话是「已归档对话暂时无法查看，
      // 请取消归档后查看」。留着可点会是更坏的结果：点进去是一个空会话。
      if (s.archived) cls += ' archived';
      if (navActing === s.id) cls += ' acting';
      if (navRenaming === s.id) cls += ' renaming';
      // 行首那颗点：**有等着的就显示等着的**（照 PC：「待处理交互的优先级高于
      // 共享 ongoing loading」）；没有等着才轮到"正在跑"。
      var dot = s.pending
        ? '<span class="s-dot pending"></span>'
        : (s.running ? '<span class="s-dot"></span>' : '');
      var row = '<div class="sess-line">'
        + '<button class="' + cls + '" type="button"'
        + ' data-sess="' + escapeHtml(s.id) + '">'
        + dot
        // 没有标题就用日期——原来退到取 id 的前 8 位当名字，而本机真有一个会话的 id
        // 以「session-」开头，于是整列都显示成一样的「session-」，等于没有名字。
        + '<span class="s-title">' + escapeHtml(s.title || '未命名会话') + '</span>'
        + navTail(s)
        + '</button>'
        // ⋯ 是**兄弟**不是子节点：塞进那个 button 里就成了"按钮里套按钮"，
        // 点它会同时触发"打开会话"，而且那种结构本身是无效的。
        + '<button class="s-more" type="button" aria-label="会话操作"'
        + ' data-more-menu="' + escapeHtml(s.id) + '">⋯</button>'
        + '</div>';
      if (navActing === s.id) row += navActs(s);
      if (navRenaming === s.id) {
        row += '<div class="sess-rename">'
          // 预填的是**真实标题**（没有就是空的），绝不是「未命名会话」那个显示占位——
          // 把占位当标题提交，就等于凭空把"未命名"三个字钉成一个真标题。
          + '<input id="renameInput" type="text" value="' + escapeHtml(s.title || '')
          + '" placeholder="给这个会话起个名字" aria-label="会话标题">'
          + '<button type="button" data-rename-cancel="1">取消</button>'
          + '<button type="button" data-rename-ok="1">确定</button>'
          + '</div>';
      }
      return row;
    }).join('');
    // 「展开其余 N 个 / 收起」。**这里原来是一句死话**（「只列了最近 N 条，共 M 条」），
    // 展不开也搜不了，用户只能去电脑上找。现在按官方口径真的展开。
    if (view.expandable) {
      html += '<button class="sess-more" type="button" data-more="' + escapeHtml(wsId) + '">'
        + '展开其余 ' + view.step + ' 个</button>';
    } else if (view.collapsed) {
      html += '<button class="sess-more" type="button" data-less="' + escapeHtml(wsId) + '">收起</button>';
    }
    return html;
  }

  /**
   * 会话列表里的一条（拿真实数据用，比如"当前标题是什么"）。
   * 找不到返回 null——调用方据此如实说"刷新一下再看看"，而不是凭空造一个。
   */
  function navSessionById(id) {
    var keys = Object.keys(navSessions);
    for (var i = 0; i < keys.length; i++) {
      var got = navSessions[keys[i]];
      var list = (got && got.sessions) || [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === id) return { wsId: keys[i], row: list[j], got: got };
      }
    }
    return null;
  }

  function toggleActs(id) {
    navRenaming = '';
    navActing = navActing === id ? '' : id;
    renderNav();
  }

  function startRename(id) {
    navActing = '';
    navRenaming = id;
    renderNav();
    // 光标落在末尾：用户多半是想改几个字，不是想全部重打。
    var input = $('renameInput');
    if (input && input.focus) {
      try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    }
  }

  /**
   * 提交改名。
   *
   * **这一步就是"不误钉"的全部**：官方 `SessionTitleService.rename` 的原文是
   * 「Appends a `session/title` event with the `user` source, which **pins** the title:
   * in-flight automatic generation is superseded and later user messages schedule none」
   * ——也就是说**传什么都会钉住**，哪怕跟当前那条自动标题一字不差。
   * 所以"没改"就**根本不发这一趟**（用户双击进来又原样退出的情形很常见）。
   */
  function renameSubmit() {
    var id = navRenaming;
    var found = navSessionById(id);
    if (!found) { navRenaming = ''; renderNav(); toast('这个会话不在了，刷新一下再看看'); return; }
    var input = $('renameInput');
    var next = input ? input.value : '';
    var current = typeof found.row.title === 'string' ? found.row.title : '';
    // 只比"归一化之后"的那一份（去空白）。官方那边也会 trim，比原始串会把
    // "结尾多了一个空格"当成真改动，那正是要避开的误钉。
    if (next.trim() === current.trim()) {
      navRenaming = '';
      renderNav();
      return;
    }
    if (!next.trim()) { toast('标题不能为空'); return; }
    return api('/mini/api/session/rename', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, title: next }),
    }).then(function (res) {
      navRenaming = '';
      // 用**服务端接受的那一份**改本地这一行：官方会归一化（去控制字符、按字节截断），
      // 界面要显示的是它认下来的那个标题，不是我们递过去的那串。
      found.row.title = res && typeof res.title === 'string' ? res.title : next;
      renderNav();
      toast('已改名');
    }).catch(function (err) { toast(err.message); });
  }

  /**
   * 分叉会话。电脑端那个功能在手机上等价的一下：在**最后一个已完成轮次**处复制出
   * 一个新会话，标题递增。
   *
   * 三件事照电脑端的原样，一件都不能走样：
   *   · **不打开新会话**：PC 那条路上 `navigation.forkSession()` 之后就结束了，
   *     没有任何切换动作。所以这里也**一个字都不碰 `state.boundSessionId`**。
   *   · **成功后刷新列表**：新会话是 PC 侧栏那种"排在源会话旁边"的普通行，得重新问一次
   *     服务端才看得见。而且必须带 `refresh=1`——服务端那份会话清册有 30 秒缓存，
   *     不绕过的话用户会看到"按了但什么都没多出来"（刚建的会话它还答不上来）。
   *   · **失败时说 Host 那句话**：`err.message` 就是服务端转发过来的原话
   *     （"没有已结束的轮次"那一种带上 Host 的英文原文），这里**不加工、不换词**。
   */
  function forkAct(id) {
    return api('/mini/api/session/fork', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    }).then(function (res) {
      navActing = '';
      var found = navSessionById(id);
      refreshSessions(found ? found.wsId : '', true);
      // 把新标题报出来：手机列表可能很长，"多了一条"这句话不如"多了一条叫什么"有用，
      // 标题里那个 (1) 也正是"它是刚才那条分出来的"最直接的凭据。
      toast(res && res.title ? '已分叉出「' + res.title + '」' : '已分叉出新会话');
    }).catch(function (err) { toast(err.message); });
  }

  /** 置顶 / 取消置顶。*/
  function pinAct(id, on) {
    return api('/mini/api/session/pin', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, pinned: on }),
    }).then(function () {
      var found = navSessionById(id);
      if (found) found.row.pinned = on;
      // 置顶会改整个列表的顺序，所以这次要重新问一遍服务端（别自己在本地排——
      // 官方的置顶顺序是"最近置顶的在前"，本地排不出那个顺序）。
      refreshSessions(found ? found.wsId : '');
      navActing = '';
      toast(on ? '已置顶' : '已取消置顶');
    }).catch(function (err) { toast(err.message); });
  }

  /**
   * 归档 / 取消归档。
   *
   * `stop` 那一次往返是**官方那条两段式流程**：不带它，会话还有工作在跑时服务端会拒绝，
   * 同时把"会停掉什么"按族带回来（见 lib/index.js 的 archiveSession）。
   * 拿到那一份就弹确认框问过用户再来一次——**不自己猜会停掉什么**。
   */
  function archiveAct(id, stop) {
    return api('/mini/api/session/archive', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id, stop: stop === true }),
    }).then(function () {
      // **先把确认框收掉**，再动别的。漏了这一句的后果实测过：那一层是
      // fixed/inset:0，z-index 120——归档成功之后它仍然盖在整屏上，
      // 用户接下来点哪儿都是点到它（点哪儿都当成"取消"，什么都没发生）。
      navConfirm = null;
      renderNavConfirm();
      navActing = '';
      var found = navSessionById(id);
      if (found) { found.row.archived = true; found.row.pinned = false; }
      refreshSessions(found ? found.wsId : '');
      toastAction('会话已归档', '撤销', function () {
        api('/mini/api/session/unarchive', {
          method: 'POST', body: JSON.stringify({ sessionId: id }),
        }).then(function () {
          var f = navSessionById(id);
          if (f) f.row.archived = false;
          refreshSessions(f ? f.wsId : '');
          toast('已取消归档');
        }).catch(function (err) { toast(err.message); });
      });
    }).catch(function (err) {
      var body = err && err.body;
      if (err && err.status === 409 && body && body.reason === 'active') {
        var found = navSessionById(id);
        navConfirm = {
          sessionId: id,
          title: (found && found.row.title) || '',
          wsId: found ? found.wsId : '',
          activity: Array.isArray(body.activity) ? body.activity : [],
        };
        renderNavConfirm();
        return;
      }
      toast(err.message);
    });
  }

  /** 取消归档。说明里那句"不恢复置顶"是官方的规矩，如实说。 */
  function unarchiveAct(id) {
    return api('/mini/api/session/unarchive', {
      method: 'POST', body: JSON.stringify({ sessionId: id }),
    }).then(function () {
      navActing = '';
      var found = navSessionById(id);
      if (found) found.row.archived = false;
      refreshSessions(found ? found.wsId : '');
      toast('已取消归档');
    }).catch(function (err) { toast(err.message); });
  }

  /**
   * 官方那四族工作的中文说法。**四种一一对应，不多不少**——`kind` 是从
   * `SessionActivityKindMap`（turn / job / subagent / schedule）来的，认不出的
   * 如实写它的原名，不硬套一个近义词。
   */
  var ACTIVITY_COPY = {
    turn: '进行中的回合',
    job: '后台任务',
    subagent: '运行中的子智能体',
    schedule: '定时提醒',
  };

  function renderNavConfirm() {
    var el = $('navConfirm');
    if (!el) return;
    if (!navConfirm) { el.classList.remove('on'); return; }
    $('navConfirmDesc').textContent = '「' + (navConfirm.title || '这个会话')
      + '」还有正在进行的工作。归档会先停止这些工作；被停止的工作不会自动继续。'
      + '归档之后它就不在列表里了，接下来 6 秒里可以点提示上的「撤销」把它找回来；'
      + '过了这几秒，就得到电脑端才能取消归档。';
    var items = (navConfirm.activity || []).map(function (fam) {
      var name = ACTIVITY_COPY[fam.kind] || fam.kind;
      var labels = (fam.items || []).map(function (it) {
        return escapeHtml(it.label || it.id || '（没有名字）');
      });
      var head = '<b>' + escapeHtml(name) + '</b>：';
      // 一项一项列出来；带不下就如实说"共 N 项"，不假装只有这几项。
      var detail = labels.length ? labels.join('、') : '（没有名字）';
      var more = fam.count > labels.length ? '（共 ' + fam.count + ' 项）' : '';
      return '<li>' + head + detail + more + '</li>';
    }).join('');
    $('navConfirmList').innerHTML = items || '<li>（没能问出具体是哪几项工作）</li>';
    el.classList.add('on');
  }

  /**
   * 重新问一遍某个工作区的会话（置顶/归档之后顺序和状态都变了）。
   *
   * `force` 是给**分叉**用的：会话清册在服务端有 30 秒缓存，而分叉是"多出来一条"，
   * 缓存里根本没有它。不带 force 的那几处（置顶/归档）只要状态和顺序，缓存那份就够。
   *
   * **`loadWsSessions` 必须排在 `renderNav` 前面**（2026-10-09 活页面验证逮住的）：
   * renderNav 自己会给每个展开着的工作区起一趟 `loadWsSessions(id)`（**不带 force**），
   * 而那一趟会先把 `navWsFetching` 占住——后面这一趟带 force 的就被那道闩挡在门外，
   * 结果新会话压根没被取回来（界面看着像"按了没反应"）。先起带 force 的这一趟，
   * renderNav 顺手起的那一趟自然就被同一道闩挡掉了。
   */
  function refreshSessions(wsId, force) {
    if (!wsId) { loadWorkspaces(true); return; }
    delete navSessions[wsId];
    delete navWsFetching[wsId];
    loadWsSessions(wsId, force);
    renderNav();
  }

  /** 「展开其余」：页里还有就只是多摆几条；页里没了就去服务端多要一批。 */
  function expandMore(wsId) {
    var got = navSessions[wsId];
    var view = got ? navVisible(wsId, got) : null;
    if (view && view.remaining > 0) {
      navExtra[wsId] = (navExtra[wsId] || 0) + 1;
      renderNav();
      return;
    }
    // 页里已经摆完了，但服务端说这个工作区还有没取回来的：把这次要的条数翻上去。
    navExtra[wsId] = (navExtra[wsId] || 0) + 1;
    navLimit[wsId] = Math.min(100, (navLimit[wsId] || NAV_PAGE) + NAV_PAGE * 2);
    delete navSessions[wsId];
    delete navWsFetching[wsId];
    loadWsSessions(wsId);
  }

  function collapseMore(wsId) {
    navExtra[wsId] = 0;
    renderNav();
  }

  // 筛选一改，所有工作区那份数据就都不作数了（服务端按筛选给的是不同的列表）。
  // **展开次数也一起归零**：换了口径还停在"展开了 3 页"，用户会莫名其妙的。
  function setShowArchived(on) {
    navShowArchived = on === true;
    navSessions = {};
    navExtra = {};
    navLimit = {};
    navActing = '';
    navRenaming = '';
    Object.keys(navFollowTimers).forEach(function (id) { clearTimeout(navFollowTimers[id]); });
    navFollowTimers = {};
    renderNav();
  }

  // ---------------- 新建工作区：浏览电脑目录 ----------------
  //
  // 面板里有两个「屏」：工作区树（默认）和目录浏览。用一个变量记当前在哪一屏，
  // 而不是再开一层浮层——手机屏幕就这么大，多一层就多一次「怎么退回去」。
  //
  // 起点给「常用位置」（主目录 / 最近用过 / 磁盘），不是直接甩盘符：
  // 从 C:\ 一层层点进去找一个项目文件夹，是要人自己知道路径长什么样。
  var navView = 'tree';
  var browseRoots = null;   // 常用位置，开一次取一次
  var browseAt = null;      // 当前所在目录；null = 还在看常用位置
  var browseData = null;    // 当前目录的列表
  var browseMkdir = false;  // 是不是正在新建文件夹（那一行输入框露出来没有）
  var browseBusy = false;   // 防连点

  function dirName(p) {
    var parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p);
  }

  function openBrowse() {
    navView = 'browse';
    browseAt = null;
    browseData = null;
    browseMkdir = false;
    renderNav();
    if (browseRoots) return;
    api('/mini/api/browse/roots').then(function (body) {
      browseRoots = body;
      renderNav();
    }).catch(function (err) {
      browseRoots = null;
      $('navBody').innerHTML = '<button class="nav-cta" type="button" data-browse-back="1">← 返回</button>'
        + '<div class="placeholder">读不到常用位置：' + escapeHtml(err.message) + '</div>';
    });
  }

  function browseTo(p) {
    navView = 'browse';
    browseAt = p;
    browseData = null;
    browseMkdir = false;
    renderNav();
    api('/mini/api/browse?path=' + encodeURIComponent(p)).then(function (body) {
      browseData = body;
      renderNav();
    }).catch(function (err) {
      browseData = { ok: false, error: err.message };
      renderNav();
    });
  }

  /** 目录浏览那一屏。路径来自服务端，这里只负责画。 */
  function renderBrowse() {
    var html = '<button class="nav-cta" type="button" data-browse-back="1">← 返回</button>';

    if (!browseAt) {
      if (!browseRoots) {
        $('navBody').innerHTML = html + '<div class="placeholder">正在读取…</div>';
        return;
      }
      // 顺序有讲究：主目录（最常用）→ 最近用过（第二常用）→ 磁盘（兜底）。
      // 磁盘排最后，因为「从盘符一层层点」正是我们要避免的那种走法。
      var rows = [{ name: '主目录', path: browseRoots.home, tag: '常用' }];
      (browseRoots.recent || []).forEach(function (p) {
        rows.push({ name: dirName(p), path: p, tag: '最近' });
      });
      (browseRoots.drives || []).forEach(function (p) {
        rows.push({ name: p, path: p, tag: '磁盘' });
      });
      html += '<div class="nav-note">挑一个文件夹，登记成工作区。</div>';
      html += rows.map(function (r) {
        return '<button class="sess" type="button" data-browse-to="' + escapeHtml(r.path) + '">'
          + '<span class="s-title">' + escapeHtml(r.name) + '</span>'
          + '<span class="s-meta">' + escapeHtml(r.tag) + '</span>'
          + '</button>';
      }).join('');
      $('navBody').innerHTML = html;
      return;
    }

    if (!browseData) {
      $('navBody').innerHTML = html + '<div class="placeholder">正在读取…</div>';
      return;
    }
    if (!browseData.ok) {
      // 读不到时**如实说**，不装作空目录——两者在界面上长得一模一样，
      // 而「没有权限」和「本来就是空的」对用户是两件事。
      $('navBody').innerHTML = html + '<div class="crumb"><span class="here">'
        + escapeHtml(dirName(browseAt)) + '</span></div>'
        + '<div class="placeholder">' + escapeHtml(browseData.error || '读不到这个目录。') + '</div>';
      return;
    }

    // 面包屑：能一路点回上去。最后一格是当前目录，不再可点。
    var chain = browseData.ancestors || [];
    html += '<div class="crumb">' + chain.map(function (a, i) {
      var last = i === chain.length - 1;
      var piece = last
        ? '<span class="here">' + escapeHtml(a.name) + '</span>'
        : '<button type="button" data-browse-to="' + escapeHtml(a.path) + '">'
          + escapeHtml(a.name) + '</button><span class="sep">›</span>';
      return piece;
    }).join('') + '</div>';

    html += '<button class="pick-here" type="button" data-pick="' + escapeHtml(browseData.path) + '">'
      + '就选这个目录</button>';

    if (browseMkdir) {
      // 内联输入，不用 window.prompt：prompt 在微信这类内嵌浏览器里会被直接
      // 屏蔽掉，那时候用户点「新建文件夹」什么都不发生，而且没有任何提示。
      html += '<div class="mkdir-row">'
        + '<input id="mkdirName" type="text" placeholder="新文件夹的名字" autocomplete="off">'
        + '<button type="button" data-mkdir-ok="1">建</button>'
        + '<button type="button" data-mkdir-cancel="1">取消</button>'
        + '</div>';
    } else {
      html += '<button class="ws-new" type="button" data-mkdir="1">＋ 新建文件夹</button>';
    }

    if (!browseData.dirs.length) {
      html += '<div class="placeholder">这个目录下面没有子目录。</div>';
    } else {
      html += browseData.dirs.map(function (d) {
        return '<button class="sess" type="button" data-browse-to="' + escapeHtml(d.path) + '">'
          + '<span class="s-title">' + escapeHtml(d.name) + '</span>'
          + '</button>';
      }).join('');
    }
    if (browseData.truncated) {
      html += '<div class="nav-note">只列了前 ' + browseData.dirs.length + ' 个，共 '
        + browseData.total + ' 个。</div>';
    }
    $('navBody').innerHTML = html;
  }

  /**
   * 「← 返回」：一级一级往外退，退法要跟用户心里的层级对上。
   *   在某个目录里 → 退回常用位置那一屏（往上几级有面包屑，不用返回键代劳）
   *   已经在常用位置 → 退回工作区树
   * 不这么做的话，从深层目录点返回会直接跳回工作区树，用户想换个盘得重新走一遍。
   */
  function closeBrowse() {
    if (browseAt) {
      browseAt = null;
      browseData = null;
      browseMkdir = false;
      renderNav();
      return;
    }
    navView = 'tree';
    renderNav();
  }

  function registerWorkspace(p) {
    if (browseBusy) return;
    browseBusy = true;
    api('/mini/api/workspaces', { method: 'POST', body: JSON.stringify({ path: p }) })
      .then(function (res) {
        browseBusy = false;
        navView = 'tree';
        browseAt = null;
        browseData = null;
        // 服务端把登记后的最新列表一起带回来了，直接用——不用再补一趟请求，
        // 也就不会出现「建好了但列表里还没有」。
        if (res && res.workspaces) navList = res.workspaces;
        navSessions = {};
        renderNav();
        toast(res && res.created
          ? '已登记《' + res.workspace.title + '》'
          : '《' + res.workspace.title + '》本来就在列表里');
      })
      .catch(function (err) {
        browseBusy = false;
        toast(err.message);
      });
  }

  function makeFolder() {
    var input = $('mkdirName');
    var name = input ? input.value : '';
    if (browseBusy) return;
    browseBusy = true;
    api('/mini/api/browse/mkdir', { method: 'POST', body: JSON.stringify({ path: browseAt, name: name }) })
      .then(function (res) {
        browseBusy = false;
        browseMkdir = false;
        browseTo(res.path);
      })
      .catch(function (err) {
        browseBusy = false;
        toast(err.message);
      });
  }

  // 标题补齐的节奏。服务端只等 250 毫秒就把列表先给出来（超时的标题留给后台），
  // 所以这里要接着问。**问几次由服务端说了算**，见 toggleWorkspace 里的说明。
  var TITLE_FOLLOW_MS = 2500;        // 每隔这么久问一次
  var TITLE_FOLLOW_LIMIT_MS = 30000; // 从展开算起，最多追这么久

  /**
   * 这份列表「还剩几条标题没读出来」。
   *
   * 优先用服务端给的 pending：那是事实（它知道还有几条日志没读完）。
   * **服务端没给这个字段时才退回数空标题**——那是「改了要重启」的半新状态下
   * （新页面配旧进程）唯一能用的判据。旧页面就是靠它补拉三次的，
   * 退回去至少有原来的效果，不会因为服务端换了版本就反而不追了。
   */
  function pendingCount(body) {
    if (body && typeof body.pending === 'number') return body.pending;
    return ((body && body.sessions) || []).filter(function (s) { return !s.title; }).length;
  }

  function toggleWorkspace(wsId) {
    if (navExpanded[wsId]) {
      delete navExpanded[wsId];
      renderNav();
      return;
    }
    navExpanded[wsId] = true;
    renderNav();
    loadWsSessions(wsId);
  }

  // 取一个工作区的会话列表。点击和 renderNav 的自愈（见 renderNav 顶部）都走这里：
  // navWsFetching 这道闩让同一工作区同时只有一趟在飞，别重复付读日志折标题的钱。
  // 15 秒兜底解锁是给「请求永远不回来」留的——闩本身不能变成新的卡死点，
  // 超过 15 秒就放行，让下一次渲染或点击还能再试（服务端有缓存，重发很便宜）。
  function loadWsSessions(wsId, force) {
    if (navSessions[wsId] || navWsFetching[wsId]) return;
    navWsFetching[wsId] = true;
    var bail = setTimeout(function () { delete navWsFetching[wsId]; }, 15000);
    var sessionsUrl = sessionsUrlOf(wsId, force);
    /**
     * 接着问，直到服务端说「一条都不剩」。
     *
     * 原来的写法是**固定补三次**（1.5 秒 / 3 秒 / 3 秒，共 7.5 秒），而一个工作区里
     * 四五个冷会话实测要 19 秒才读完——三次补拉盖不住，标题就是长不出来，
     * 用户只能退出去再进来。现在按服务端给的事实问：pending 归零就停。
     *
     * 30 秒是总时限：万一有一条日志坏了、永远读不出来，也不该没完没了地问下去。
     */
    function followTitles(cur, deadline) {
      if (!(pendingCount(cur) > 0) || Date.now() >= deadline) return;
      navFollowTimers[wsId] = setTimeout(function () {
        delete navFollowTimers[wsId];
        // 用户收起了、或者这份数据已经被刷新换掉，就放手：别跟人抢。
        if (navSessions[wsId] !== cur || !navExpanded[wsId]) return;
        api(sessionsUrlOf(wsId))
          .then(function (body) {
            if (navSessions[wsId] !== cur || !navExpanded[wsId]) return;
            navSessions[wsId] = body;
            renderNav();
            followTitles(body, deadline);
          })
          .catch(function () {
            // 追不到就算了：列表本身还在，日期也够用。
          });
      }, TITLE_FOLLOW_MS);
    }
    api(sessionsUrl)
      .then(function (body) {
        clearTimeout(bail);
        navSessions[wsId] = body;
        delete navWsFetching[wsId];
        renderNav();
        followTitles(body, Date.now() + TITLE_FOLLOW_LIMIT_MS);
      })
      .catch(function (err) {
        clearTimeout(bail);
        delete navWsFetching[wsId];
        navSessions[wsId] = { sessions: [], total: 0 };
        renderNav();
        toast(err.message);
      });
  }

  /**
   * 取一个工作区会话列表的地址。三个参数都是**这次的口径**：
   *   · `archived=1` 只在「显示已归档」打开时带——默认那一档是隐藏已归档（官方默认项）。
   *   · `limit` 只在"要过更多"时才带，平时不带。**不带就还是原来那条地址**：
   *     多带一个参数会让服务端每次都走一条不一样的路径，也没必要。
   *   · `refresh=1` 只在**刚刚多出一条会话**（分叉）时才带：服务端那份清册有 30 秒缓存，
   *     不绕过的话新会话不在里面。
   */
  function sessionsUrlOf(wsId, force) {
    var url = '/mini/api/workspaces/' + encodeURIComponent(wsId) + '/sessions';
    var parts = [];
    if (navShowArchived) parts.push('archived=1');
    if (navLimit[wsId]) parts.push('limit=' + navLimit[wsId]);
    if (force) parts.push('refresh=1');
    return parts.length ? url + '?' + parts.join('&') : url;
  }

  // 防连点。建会话**不是幂等的**——点两下就在电脑上真建出两个会话来，
  // 而手机上什么都看不出来（第二个只是把列表撑长了一行）。所以这里必须自己拦。
  // 服务端那道闸门拦不住这个：两个请求都是合法的。
  var creatingSession = false;

  function createSession(wsId, agentPreset) {
    // 2026-10-04 用户要求：新建会话时手机上也要能选 agent 模式（PC 一直可以）。
    // 多于一种模式、又没点名要哪种：先把清单行内展开让用户挑（照「新建文件夹」的
    // 先例，不弹窗）；只有一种、或读不到清单：直接建 DSH 的默认模式——
    // **不摆只有一个选项的选择题**，也不替用户猜。
    if (agentPreset === undefined && navPresets && navPresets.ok && navPresets.presets.length > 1) {
      navPickerWs = navPickerWs === wsId ? '' : wsId;
      renderNav();
      return Promise.resolve();
    }
    navPickerWs = '';
    if (creatingSession) return;
    creatingSession = true;
    Array.prototype.forEach.call($('navBody').querySelectorAll('.ws-new'), function (el) {
      el.disabled = true;
    });
    function done() {
      creatingSession = false;
      Array.prototype.forEach.call($('navBody').querySelectorAll('.ws-new'), function (el) {
        el.disabled = false;
      });
    }
    // POST 到工作区会话那条路径上：GET 是「列出来」，POST 是「建一个」。
    // 服务端建完会顺手 bind 并把新快照一起返回，所以这里一次请求就完成了
    // 「建 + 切过去」，不用再补一次 bind。
    //
    // **要把 promise 返回出去**：起了异步动作就该让调用方等得到它。
    // 不返回的话外面拿到的是 undefined，接不上任何后续。
    return api('/mini/api/workspaces/' + encodeURIComponent(wsId) + '/sessions', {
      method: 'POST',
      body: agentPreset ? JSON.stringify({ agentPreset: agentPreset }) : '{}',
    }).then(function (res) {
      done();
      // 接口把绑定后的快照一起给了，直接渲染——不这样的话，切过去的一瞬间
      // 屏幕上还留着上一个会话的正文。
      if (res && res.state) applySnapshot(res.state);
      else render();
      closeNav();
      toast('已在《' + ((res && res.workspaceTitle) || '工作区') + '》里建好新会话');
      // 让列表里立刻出现这条新会话。force 是为了绕过服务端那份 30 秒的缓存——
      // 刚建的会话它还不知道，不绕过的话切回来会「咦刚才那条呢」。
      loadWorkspaces(true);
    }).catch(function (err) {
      done();
      toast(err.message);
    });
  }

  function bindSession(id) {
    if (!id) return;
    api('/mini/api/bind', { method: 'POST', body: JSON.stringify({ sessionId: id }) })
      .then(function (res) {
        // 接口把切换后的快照一起返回了，直接用它渲染——不用干等 SSE 那一趟。
        // 不这样的话，切过去的一瞬间屏幕上还留着上一个会话的内容。
        if (res && res.state) applySnapshot(res.state);
        else { state.boundSessionId = id; render(); }
        closeNav();
        toast('已切换会话');
      })
      .catch(function (err) { toast(err.message); });
  }

  // 当前会话可能在电脑上被切走。这里只改高亮，不重绘整棵树——重绘会把
  // 用户正在划的滚动位置弹回顶部。
  function paintNavCurrent() {
    if (!$('nav').classList.contains('open')) return;
    var cur = state.boundSessionId;
    Array.prototype.forEach.call($('navBody').querySelectorAll('.sess'), function (el) {
      el.classList.toggle('cur', el.getAttribute('data-sess') === cur);
    });
  }

  // 归档确认面板。**它自己带两个按钮，不走 navBody 那套委托**：
  // 它在抽屉之外、是一整屏的浮层，混进列表的事件里只会让人以为它也是列表的一部分。
  //
  // 确认后**才**带 stop:true 重发——被停掉的工作不会自动继续，所以这一下必须是人按的。
  $('navConfirm').addEventListener('click', function (e) {
    var t = e.target;
    if (t === $('navConfirm') || (t && t.closest && t.closest('[data-nc-cancel]'))) {
      navConfirm = null;
      renderNavConfirm();
      return;
    }
    var ok = t && t.closest ? t.closest('[data-nc-ok]') : null;
    if (!ok || !navConfirm) return;
    // 按下去先禁掉：这一趟会在电脑上真停东西，连点两下没有第二件事可做。
    ok.disabled = true;
    archiveAct(navConfirm.sessionId, true);
  });
  // 改名那一行：手机键盘上是「回车」，桌面上是 Enter。不接这个键的话，
  // 用户打完字的第一反应（回车）什么都不会发生。
  $('navBody').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (!t || t.id !== 'renameInput') return;
    e.preventDefault();
    renameSubmit();
  });

  $('btnNav').addEventListener('click', openNav);
  $('btnNavClose').addEventListener('click', closeNav);
  $('btnNavRefresh').addEventListener('click', function () { loadWorkspaces(true); });
  $('nav').addEventListener('click', function (e) { if (e.target === $('nav')) closeNav(); });

  $('navBody').addEventListener('click', function (e) {
    var t = e.target;
    var at = function (sel) { return t && t.closest ? t.closest(sel) : null; };
    var sess = t && t.closest ? t.closest('.sess') : null;
    if (sess) {
      // 目录浏览那一屏里的 .sess 是「进这个目录」，不是「切到这个会话」。
      // 两屏共用同一个条目样式，所以要先看当前在哪一屏。
      if (navView === 'browse') { browseTo(sess.getAttribute('data-browse-to')); return; }
      // 已归档的**点不开**（官方原话：「已归档对话暂时无法查看，请取消归档后查看」）。
      // 留着能点更坏：点进去是一个空会话，用户只会以为会话被清空了。
      var bound = navSessionById(sess.getAttribute('data-sess'));
      if (bound && bound.row.archived) {
        toast('已归档的会话打不开，先取消归档');
        return;
      }
      bindSession(sess.getAttribute('data-sess'));
      return;
    }

    // —— 会话条目的执行入口（2026-10-09）。都排在下面那些之前，
    //    因为它们都挂在会话那一行上，和「新建会话 / 展开工作区」不是一类。 ——
    var menu = at('[data-more-menu]');
    if (menu) { toggleActs(menu.getAttribute('data-more-menu')); return; }
    var act = at('[data-act]');
    if (act) {
      var actId = act.getAttribute('data-act-id');
      var which = act.getAttribute('data-act');
      if (which === 'rename') startRename(actId);
      else if (which === 'fork') forkAct(actId);
      else if (which === 'pin') pinAct(actId, act.getAttribute('data-act-on') !== '1');
      else if (which === 'archive') archiveAct(actId, false);
      else if (which === 'unarchive') unarchiveAct(actId);
      return;
    }
    if (at('[data-rename-cancel]')) { navRenaming = ''; renderNav(); return; }
    if (at('[data-rename-ok]')) { renameSubmit(); return; }
    var more = at('[data-more]');
    if (more) { expandMore(more.getAttribute('data-more')); return; }
    var less = at('[data-less]');
    if (less) { collapseMore(less.getAttribute('data-less')); return; }
    if (at('[data-archived-toggle]')) { setShowArchived(!navShowArchived); return; }

    var newWs = at('[data-new-ws]');
    if (newWs) { openBrowse(); return; }
    var back = at('[data-browse-back]');
    if (back) { closeBrowse(); return; }
    var to = at('[data-browse-to]');
    if (to) { browseTo(to.getAttribute('data-browse-to')); return; }
    var pick = at('[data-pick]');
    if (pick) { registerWorkspace(pick.getAttribute('data-pick')); return; }
    if (at('[data-mkdir]')) { browseMkdir = true; renderNav(); return; }
    if (at('[data-mkdir-cancel]')) { browseMkdir = false; renderNav(); return; }
    if (at('[data-mkdir-ok]')) { makeFolder(); return; }

    // 模式清单里点一项：带着这个模式去建（2026-10-04，手机上也能选 agent 模式）。
    var mode = at('[data-mode-preset]');
    if (mode) {
      createSession(mode.getAttribute('data-mode-ws'), mode.getAttribute('data-mode-preset'));
      return;
    }
    // 「新建会话」要排在 ws-head 之前判：它在 ws-body 里面、不是 ws-head，
    // 顺序上无所谓，但放在前面更清楚——这一支是动作，那一支是展开/收起。
    var fresh = at('.ws-new');
    if (fresh) { createSession(fresh.getAttribute('data-newws')); return; }
    var head = at('.ws-head');
    if (!head) return;
    toggleWorkspace(head.parentNode.getAttribute('data-ws'));
  });

  // ---------------- SSE ----------------
  /** 从轨迹中取当前轮号：正在跑的那一组的轮号。没有就返回 null。 */
  function currentTrajectoryTurn() {
    var groups = state.trajectory || [];
    for (var i = groups.length - 1; i >= 0; i--) {
      var g = groups[i];
      if (g && g.state === 'running' && g.turn != null) return g.turn;
    }
    // 没有正在跑的，取最近一个有轮号的
    for (var j = groups.length - 1; j >= 0; j--) {
      var h = groups[j];
      if (h && h.turn != null) return h.turn;
    }
    return null;
  }

  /**
   * 这条流是谁——轨迹订阅按连接记，就得先有身份。
   *
   * 服务端手上只有一条条 SSE 连接（`res`），一次普通的 POST 认不出「我是哪条流」。
   * 所以由客户端自己报一个随机串，两处都带上：连流时的 `?clientId=…`，和之后每次
   * 开关订阅的 POST。不报也能用，只是那种连接订不了轨迹。
   *
   * 存 `sessionStorage`（不是 localStorage）：一个标签页一个身份，第二个标签页不会
   * 跟这一页抢同一条订阅；刷新后还在，免得每刷一次就多出一个「认不出」的连接。
   * 无痕模式下存取会抛，就地退回「本次运行内固定」——订不上，但不影响别的功能。
   */
  var clientId = '';
  try {
    clientId = sessionStorage.getItem('dshMiniClient') || '';
    if (!clientId) {
      clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem('dshMiniClient', clientId);
    }
  } catch (e) {
    clientId = 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  /** 服务端此刻认作「订了轨迹」的那个身份；空串 = 没订（切换模式的开关拿它判断）。 */
  var subscribedClientId = '';
  /**
   * 这条活连接**建的时候有没有带 `stream=1`**（2026-10-22）。
   *
   * 不能只用 `state.streaming` 判断：开关开着，但连接是在「单帧」模式下建的、
   * 或者是在切模式之前建的，它照样收不到正文帧。这里记的是「连上时真带了没有」，
   * 和当前想要的比一比，不一样就重连。
   */
  var streamSubscribed = false;
  var es = null;
  /**
   * 轮询兜底那几样（2026-11-27，见 connect() 末尾那段）。
   *
   * `lastFrameAt` 是**这条 SSE 最后一帧到达的时刻**——它是「SSE 到底有没有在送东西」的
   * 唯一判据。有些公网通路会把整条流整段缓冲，这时 `EventSource` 仍然是 open（浏览器
   * 不报错），只有这个时刻会一直不动。
   */
  var pollTimer = null;
  var lastFrameAt = 0;
  var pollRev = -1;
  var stateRefreshing = false;
  // 拉整页快照的最小间隔。`rev` 一变就拉最准，但一轮里 rev 可能每秒变好几次——
  // 那样等于在手机上跑一个 4 KB/s 的长连接。10 秒一次既跟得上进度，又把流量压到 1/3。
  var STATE_MIN_GAP_MS = 10000;
  var stateFetchedAt = 0;
  // 15 秒 > 服务端心跳的 10 秒：**只要心跳还在到，就说明这条流是通的**，一个请求都不发。
  // 被整段缓冲时连心跳也到不了，15 秒后自动切轮询（最多再晚 3 秒一拍）。
  var POLL_STALE_MS = 15000;
  var POLL_FIRST_MS = 8000;
  var POLL_EVERY_MS = 3000;
  function connect() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (!state.entered) { showGate(); return; }
    lastFrameAt = Date.now();
    setStatus('', '连接中…');
    // clientId 每条连接都带（订阅的 POST 靠它认出这条流）；full=1 只在「完整」模式带，
    // 服务端见到就自动把这条连接订上轨迹——断线重连沿用同一个地址，重新订上由服务端
    // 自己完成，客户端不用再握手一次。
    // **`stream=1`（2026-10-21）** = 「这台设备的流式开关是开的，正文也给我推」。
    // 不带它就一个正文帧都收不到——关掉流式**真的省流量**，不是前端收到了再丢掉。
    // **地址里不带令牌**（2026-10-16 第二步）：同源的 EventSource 会带上设备 cookie。
    // 「这一条连接该不该收正文帧」在建流这一刻定死；切模式 / 开关状态变了都要重连一次。
    var streamWanted = state.streaming && state.mode !== 'minimal';
    streamSubscribed = streamWanted;
    es = new EventSource('/mini/api/stream?clientId=' + encodeURIComponent(clientId)
      + (state.mode === 'full' ? '&full=1' : '')
      + (streamWanted ? '&stream=1' : '')
      // `thought=1`（2026-11-27）= 「我在聊天模式，把思考那一行也给我」。
      // 只订摘要和收尾全文，**不订轨迹**（那份单轮最高约 946KB，聊天模式用不着）。
      + (state.mode === 'chat' ? '&thought=1' : ''));

    // 给这条流套一层：**每一帧都记下到达时刻**。后面那个轮询兜底就靠它判断
    // 「SSE 是不是已经不干活了」——只在外面包一层，下面那些事件处理一个字都不用改。
    function stampFrames(source) {
      var raw = source.addEventListener.bind(source);
      source.addEventListener = function (name, fn) {
        return raw(name, function (e) {
          lastFrameAt = Date.now();
          return fn(e);
        });
      };
    }
    stampFrames(es);

    es.addEventListener('open', function () {
      state.connected = true;
      updateStatusUI();
      $('connHint').textContent = '已连接';
      prefetchWorkspaces();
      prefetchSubagents();
      if (state.mode === 'full') {
        // 首连与重连同一处：full=1 已让服务端订上这条连接，拿住身份，再对齐一次——
        // 断线那一段路上可能丢过帧，用这份 GET 把 epoch/seq 校正（换代就整个换新）。
        subscribedClientId = clientId;
        requestTrajectory();
      }
    });
    es.addEventListener('state', function (e) {
      state.connected = true;
      updateStatusUI();
      try { applySnapshot(JSON.parse(e.data)); } catch (err) {}
      prefetchWorkspaces();
      prefetchSubagents();
    });
    // 轨迹的增量帧。JSON 解析失败就丢——宁可等下一份 GET 对齐，也不拿半帧去拼。
    es.addEventListener('trajectory', function (e) {
      var frame;
      try { frame = JSON.parse(e.data); } catch (err) { return; }
      receiveTrajectoryFrame(frame);
    });
    // 活片段帧（2026-10-04 用户解禁：完整模式要「正在想的片段一点点顺出来」）。
    // 只进完整模式的轨迹组头；聊天/单帧、鲸鱼娘气泡一个字节都不碰。
    //
    // **2026-10-21 起多了一路正文**（`kind: 'text'`，配合设置页那个「流式」开关）：
    // 服务端把那一段新攒的字放在 `delta` 里推过来，这里**累加到 `state.live`**——
    // 也就是聊天与完整两个模式共用的那个「正在流出来的回答」槽位（`liveBlock` 渲染它）。
    // 落定帧（`trajectory`）一到就清空，由真条目接管，绝不把影子留在屏幕上。
    es.addEventListener('trajectory-live', function (e) {
      var frame;
      try { frame = JSON.parse(e.data); } catch (err) { return; }
      if (frame.sessionId && state.boundSessionId && frame.sessionId !== state.boundSessionId) return;
      if (frame.kind === 'text') {
        // 正文那一路：**单帧模式不跟**（用户 2026-10-21 拍板），所以这里先挡掉。
        if (state.mode === 'minimal') return;
        if (typeof frame.delta !== 'string' || !frame.delta) {
          // 空 delta = 服务端说「这一段写完了，别留残留」。
          state.streamReceived = false;
          if (state.live) { state.live = ''; render(); }
          return;
        }
        state.streamReceived = true;
        state.live = (state.live || '') + frame.delta;
        // 只换流式那一块，别每 60 毫秒重拼整串历史（见 paintLive 的说明）。
        paintLive();
        return;
      }
      if (frame.kind === 'tool') {
        // 工具参数那一路：**只有完整模式 + 流式开关开着**才用。
        // 开关关着时服务端根本不会推（`?stream=1` 没带），这里是第二道闸，防着将来协议变化。
        if (!state.streaming) return;
        if (state.mode !== 'full') return;
        if (typeof frame.delta !== 'string' || !frame.delta) {
          if (state.liveTool) { state.liveTool = null; render(); }
          return;
        }
        var prev = state.liveTool || { name: '', args: '' };
        state.liveTool = {
          // `name` 只在第一个 delta 上带，后面沿用记着的那个。
          name: typeof frame.name === 'string' && frame.name ? frame.name : prev.name,
          args: (prev.args || '') + frame.delta,
        };
        render();
        return;
      }
      if (state.mode !== 'full') return;
      state.trajectoryLive = typeof frame.detail === 'string' ? frame.detail : '';
      render();
    });
    /**
     * 本轮的计费用量（2026-11-27）：`{ sessionId, turn, step, billed, output, total, estimated }`。
     *
     * 服务端**一秒最多一帧**（节流在它那边做），`estimated: true` 表示这一步还没跑完、
     * 数字是按字数估的。落定后这个徽标会被回答自带的精确值换掉（见 reply 那条）。
     *
     * 只改徽标那一个节点：这条帧每秒都来，走 render() 等于每秒重拼一遍整串聊天。
     */
    es.addEventListener('usage', function (e) {
      var frame;
      try { frame = JSON.parse(e.data); } catch (err) { return; }
      if (!frame) return;
      if (frame.sessionId && state.boundSessionId && frame.sessionId !== state.boundSessionId) return;
      state.usage = frame;
      paintTokens();
    });
    /**
     * 聊天模式的过程清单（2026-11-27 v2，只有 `?thought=1` 那条连接会收到）。
     *
     * 两条帧，落到同一列里（见 applyThoughtFrame / applyStepRows）：
     *   · `thought`：一段思考。`step` 是步号，`delta` 是新增的字，`done:true` 带全文；
     *   · `step`   ：工具行（运行命令 / 读取 / 编辑…），同一个 id 后到的是结果补丁。
     * 换了会话就别收：这些属于上一个会话（和 trajectory-live 同一个口径）。
     */
    es.addEventListener('thought', function (e) {
      var frame;
      try { frame = JSON.parse(e.data); } catch (err) { return; }
      if (!frame) return;
      if (frame.sessionId && state.boundSessionId && frame.sessionId !== state.boundSessionId) return;
      applyThoughtFrame(frame);
    });
    es.addEventListener('step', function (e) {
      var frame;
      try { frame = JSON.parse(e.data); } catch (err) { return; }
      if (!frame || !Array.isArray(frame.rows)) return;
      if (frame.sessionId && state.boundSessionId && frame.sessionId !== state.boundSessionId) return;
      applyStepRows(frame.rows);
    });
    es.addEventListener('navigation-title', function (e) {
      var payload;
      try { payload = JSON.parse(e.data); } catch (err) { return; }
      if (!payload || typeof payload.workspaceId !== 'string' || typeof payload.sessionId !== 'string') return;
      var got = navSessions[payload.workspaceId];
      if (!got || !Array.isArray(got.sessions)) return;
      var row = got.sessions.find(function (item) { return item.id === payload.sessionId; });
      if (!row) return;
      row.title = typeof payload.title === 'string' ? payload.title : '';
      if (typeof got.pending === 'number' && got.pending > 0) got.pending -= 1;
      if (got.pending <= 0 && navFollowTimers[payload.workspaceId]) {
        clearTimeout(navFollowTimers[payload.workspaceId]);
        delete navFollowTimers[payload.workspaceId];
      }
      if (navExpanded[payload.workspaceId] && navView === 'tree') renderNav();
    });
    es.addEventListener('navigation-pending', function (e) {
      // 谁在等人变了。**只就地换那几行的尾部标记**，不重绘整棵树——
      // 重绘会把用户正在划的滚动位置弹回顶部（和 paintNavCurrent 同一条理由）。
      var map;
      try { map = JSON.parse(e.data); } catch (err) { return; }
      if (!map || typeof map !== 'object') return;
      var touched = false;
      Object.keys(navSessions).forEach(function (wsId) {
        var got = navSessions[wsId];
        if (!got || !Array.isArray(got.sessions)) return;
        got.sessions.forEach(function (s) {
          var next = typeof map[s.id] === 'string' ? map[s.id] : null;
          if (s.pending !== next) { s.pending = next; touched = true; }
        });
      });
      if (touched && $('nav').classList.contains('open') && navView === 'tree') renderNav();
    });
    es.addEventListener('subagent-metrics', function (e) {
      var payload;
      try { payload = JSON.parse(e.data); } catch (err) { return; }
      if (!payload || payload.parentSessionId !== state.boundSessionId) return;
      var row = null;
      for (var i = 0; i < saRows.length; i++) {
        if (saRows[i].id === payload.childId) { row = saRows[i]; break; }
      }
      if (!row) return;
      row.tokens = payload.tokens;
      row.durationMs = payload.durationMs;
      row.lastTurnCompleted = payload.lastTurnCompleted;
      if (saCache && saCacheSession === state.boundSessionId) {
        for (var k = 0; k < (saCache.subagents || []).length; k++) {
          if (saCache.subagents[k].id === payload.childId) {
            Object.assign(saCache.subagents[k], payload);
            break;
          }
        }
      }
      if (saPanel.classList.contains('open') && !saCurrent) saRenderList(saCache || { ok: true, subagents: saRows });
    });
    es.addEventListener('navigation-refresh', function () {
      navList = null;
      navSessions = {};
      saCache = null;
      saCacheSession = null;
      saCacheAt = 0;
      if ($('nav').classList.contains('open')) loadWorkspaces(false);
      else prefetchWorkspaces();
    });
    es.addEventListener('reply', function (e) {
      var payload = JSON.parse(e.data);
      // interrupted 必须带上：这条是「实时推过来的那一条」，走的是和刷新时
      // （/mini/api/state 的完整快照）不同的代码路径。漏了的话，被按停的那半句话
      // 在实时推送时不会标「已停止」，得刷新一下才出现——测试全绿但真机是坏的。
      var cut = payload.interrupted === true;
      state.latest = {
        text: payload.text, timestamp: payload.timestamp,
        sessionId: payload.sessionId, interrupted: cut,
        // 这一轮花了多少（2026-11-27）：跟着回答一起存，单帧模式直接画它。
        usage: payload.usage || null,
      };
      // 完整模式画的也是这串聊天记录（renderFull 复用 renderChat），回复落定
      // 同样要追加进去，否则要等下一份快照才补上；单帧不画记录，照旧不进。
      if (state.mode !== 'minimal') {
        state.history = (state.history || []).concat([
          {
            role: 'assistant', text: payload.text, timestamp: payload.timestamp,
            sessionId: payload.sessionId, interrupted: cut,
            // 用量跟着这条回答走（2026-11-27）：刷新后从服务端快照回来的那份也带它。
            usage: payload.usage || null,
            // 完整模式把轨迹块插回对话原位要用：从轨迹中取当前轮号。
            // 手机本地回显时轮还没开，先留空；服务端快照补上来时会带上真轮号。
            turn: currentTrajectoryTurn(),
          }
        ]);
      }
      // **落定的回答到了，流式的影子让位**（2026-10-22）。块结束时服务端会补发最后一截
      // 尾巴、并且**不再紧跟一个空帧**（那样会把刚补的字一起抹掉），清屏的责任在这里：
      // 先把 live 清掉再画，屏幕上只留真正的回答，不会出现「同一段话两遍」。
      state.live = '';
      state.liveTool = null;
      state.streamReceived = false;
      // 流式那份估的读数到此为止：屏幕上换成了回答自带的精确值（payload.usage）。
      state.usage = null;
      // 这一轮的过程（思考 + 工具步骤）从此**挂到这条回答上**（2026-11-27 v2）：
      // 之后翻页、重画都跟着它走。**不要求最后一步已 done**——被打断的那一轮也该留住
      // 已经看到的过程，不然屏幕上的清单会凭空消失。
      // **就地写，不抽成函数**：这段监听被 page.test.mjs 的 feedReply 单独抠出来跑，
      // 抽出去的那个函数不在切片里，一跑就是 ReferenceError（这一条踩过）。
      var think = state.thinking;
      if (think && think.steps && think.steps.length && payload.timestamp) {
        state.thoughts[payload.timestamp] = { steps: think.steps.slice() };
        state.thinking = null;
        // 只留最近 8 条：再往前的过程本来也看不到了（服务端重放里没有 reasoning）。
        var thinkKeys = Object.keys(state.thoughts);
        while (thinkKeys.length > 8) {
          delete state.thoughts[thinkKeys[0]];
          thinkKeys = Object.keys(state.thoughts);
        }
      }
      setRunning(false);
      render();
      if (!document.hidden) {
        playDing(); buzz();
      } else {
        // 页面在后台时，响铃和震动都叫不醒人——那两样只在页面看得见的时候有用。
        //
        // 原来这里指望系统通知兜底。2026-09-25 试到底了：**锁屏时系统会冻结后台页面**，
        // 实时连接断掉，这段代码根本轮不到执行。不锁屏的后台（切到别的应用）它倒是能用，
        // 但用户试过之后决定浏览器里不做这个功能了，理由和处置见下面「页面在后台时提醒」。
        //
        // 调用留着：开关不露出来了，state.notify 就永远是 false，这个函数会立刻返回。
        notifySystem(payload.text);
      }
    });
    // ——— 回答电脑的提问 ———
    //
    // 电脑那边提问时，插件把题目推一条 `question` 过来，答完 POST 回 /mini/api/answer。
    // 三条是用户定下的：一个一个答（答完这题才出下一题）、点错了能回头改、能自己打字。
    let ask = null
    function askRender() {
      if (!ask) return
      const q = ask.questions[ask.i]
      $('askHead').textContent = ask.questions.length > 1
        ? '电脑问你第 ' + (ask.i + 1) + ' 题，一共 ' + ask.questions.length + ' 题'
        : '电脑在问你一件事'
      $('askText').textContent = q.question || ''
      $('askDetail').textContent = q.detail || ''
      $('askDetail').style.display = q.detail ? '' : 'none'
      const picked = ask.picked[ask.i] || { selected: [], custom: '' }
      const box = $('askOpts')
      box.innerHTML = ''
      const options = Array.isArray(q.options) ? q.options : []
      options.forEach(function (o) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'opt' + (picked.selected.indexOf(o.label) >= 0 ? ' sel' : '')
        const name = document.createElement('span')
        name.textContent = o.label
        btn.appendChild(name)
        if (o.description) {
          const sub = document.createElement('small')
          sub.textContent = o.description
          btn.appendChild(sub)
        }
        btn.addEventListener('click', function () {
          // 允许多选的题就点一下选中、再点一下取消；单选的点谁就是谁。
          if (q.multiSelect) {
            const at = picked.selected.indexOf(o.label)
            if (at >= 0) picked.selected.splice(at, 1)
            else picked.selected.push(o.label)
          } else {
            picked.selected = [o.label]
          }
          // 选了选项就清掉"我自己说"——两者只留一个，免得电脑收到含糊的答案。
          picked.custom = ''
          ask.picked[ask.i] = picked
          askRender()
        })
        box.appendChild(btn)
      })
      $('askCustomWrap').style.display = ask.custom ? '' : 'none'
      $('askCustom').value = picked.custom || ''
      $('askBack').style.display = ask.i > 0 ? '' : 'none'
      $('askNext').textContent = ask.i === ask.questions.length - 1 ? '答好了，发回电脑' : '下一题'
      $('askCard').classList.remove('collapsed')
      $('askCard').classList.add('on')
      syncAskPad()
    }
    /**
     * 收起答题抽屉。**三件事必须一起做**：清 `ask`、把抽屉的 on/collapsed/dragging 全摘掉、
     * 把补给 main 的下内边距还回去。加收起态之前这三处是各写各的，只要有一处漏了，
     * 抽屉就会以半个状态挂在屏幕上（看着还在、其实已经没题了）。
     */
    function closeAskCard() {
      ask = null
      $('askCard').classList.remove('on', 'collapsed', 'dragging')
      $('askCard').style.transform = ''
      mainEl.style.paddingBottom = ''
    }
    /**
     * 让 `main` 给抽屉让出**正好那么高**的下内边距。
     *
     * 原来写死 `calc(72vh + 16px)`：卡片矮的时候底下多一大块空白，卡片高的时候又不够。
     * 现在按卡片实际高度算（收起时只有 50 多像素），滚到末尾时最后一条消息正好落在卡片上沿。
     */
    function syncAskPad() {
      var card = $('askCard')
      var on = card && card.classList.contains('on')
      var h = on ? Math.round(card.getBoundingClientRect().height) : 0
      mainEl.style.paddingBottom = h > 0 ? (h + 16) + 'px' : ''
    }
    $('askOwn').addEventListener('click', function () {
      if (!ask) return
      ask.custom = !ask.custom
      $('askCustomWrap').style.display = ask.custom ? '' : 'none'
      if (ask.custom) $('askCustom').focus()
    })
    $('askCustom').addEventListener('input', function () {
      if (!ask) return
      const picked = ask.picked[ask.i] || { selected: [], custom: '' }
      picked.custom = $('askCustom').value
      picked.selected = []
      ask.picked[ask.i] = picked
      askRender()
    })
    $('askBack').addEventListener('click', function () {
      if (!ask || ask.i === 0) return
      ask.i -= 1
      askRender()
    })
    $('askNext').addEventListener('click', function () {
      if (!ask) return
      const picked = ask.picked[ask.i] || { selected: [], custom: '' }
      if (!picked.selected.length && !(picked.custom || '').trim()) {
        toast('先选一个，或者点「我自己说」写一句')
        return
      }
      if (ask.i < ask.questions.length - 1) {
        ask.i += 1
        askRender()
        return
      }
      // 最后一题答完：把所有题的答案一起交回去。
      const askId = ask.id
      const items = askItems(ask)
      const answers = ask.questions.map(function (q, k) {
        const one = ask.picked[k] || { selected: [], custom: '' }
        const answer = { id: q.id, selected: one.selected.slice() }
        if ((one.custom || '').trim()) answer.custom = one.custom.trim()
        return answer
      })
      // 三种结果说三句不同的话。**没成事就不收卡片**：收掉了就再也没地方说这句话，
      // 用户看到的只会是「点了没反应」。
      sendAnswer(ask.id, answers).then(function (verdict) {
        if (verdict === 'failed') {
          toast('没送出去，看一眼和电脑的连接，再点一次')
          return
        }
        closeAskCard()
        // 自己答的也要**立刻看见「你选了 X」**（2026-11-27 晚）：服务端那条 chip 要等
        // 工具结果落定才推过来，而这一下用户正盯着屏幕。本地这条会和服务端那条合流
        // （判据是答案本身，见 answerInHistory），不会变成两条。
        // **`late` 不记**：那道题已经在别处被答掉了，我勾的这份没算数，画出来就是骗人。
        if (verdict === 'ok') rememberAnswer(askId, items, 'phone')
        if (verdict === 'late') toast('这道题已经交回电脑了，去电脑上答')
      })
    })
    // ——— 抽屉的拖拽 / 收起 ———
    //
    // 手指按住上面那个把手往下拖：跟手跟到 40% 屏高，松手过 60 像素就收起（只剩把手 + 标题），
    // 往上拖、或者点一下把手再展开。**只挂在把手上**（CSS 里给了 touch-action:none）——
    // 题目正文里的滑动照旧是滚动，不会误拖；这一点比"整张卡都能拖"重要得多，
    // 用户要的正是「一边拖、一边看上面的历史」。
    function dragAskSheet() {
      var card = $('askCard');
      var handle = $('askHandle');
      var startY = 0;
      var dy = 0;
      var dragging = false;
      var suppressClick = false;
      function pointOf(e) {
        var t = e.touches && e.touches[0];
        return t ? t.clientY : (typeof e.clientY === 'number' ? e.clientY : 0);
      }
      function down(e) {
        if (!ask) return;
        startY = pointOf(e);
        dy = 0;
        dragging = true;
        card.classList.add('dragging');
      }
      function move(e) {
        if (!dragging) return;
        dy = pointOf(e) - startY;
        var cap = window.innerHeight * 0.4;
        var shift = Math.max(0, Math.min(dy, cap));
        card.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
        // 拖把手的时候别让页面跟着滚：这一下必须拦。
        if (e.cancelable) e.preventDefault();
      }
      function up() {
        if (!dragging) return;
        dragging = false;
        card.classList.remove('dragging');
        card.style.transform = '';
        if (dy > 60) card.classList.add('collapsed');
        else if (dy < -40) card.classList.remove('collapsed');
        syncAskPad();

        // 拖过就不当成点击：否则松手后面那次 click 会把它又翻回去。
        if (Math.abs(dy) > 10) suppressClick = true;
      }
      handle.addEventListener('touchstart', down, { passive: true });
      handle.addEventListener('touchmove', move, { passive: false });
      handle.addEventListener('touchend', up);
      handle.addEventListener('touchcancel', up);
      // 没有触摸事件时（电脑上开这个页面、或者浏览器不给 touch）点一下也能收/展。
      handle.addEventListener('click', function () {
        if (!ask) return;
        if (suppressClick) { suppressClick = false; return; }
        card.classList.toggle('collapsed');
        syncAskPad();
      });
    }
    // 上面是函数声明，这里显式调用：**不要写成 `(function(){…})()`**——
    // 这个文件整份不写分号，以 `(` 开头的新语句会被解析成上一句的链式调用
    // （2026-11-27 线上事故：connect() 直接抛 TypeError，后面的监听器全没注册，
    //  症状是"提问卡不弹、状态/心跳/轮询都不生效"）。
    dragAskSheet();
    // ——— 命令确认（审批）———
    //
    // 电脑要做需要拍板的事时，插件推一条 `approval` 过来，点了卡上的按钮再 POST 回
    // /mini/api/approval。和答题卡同样的三条讲究：没送出去就不收卡片（收掉了就再也
    // 没地方说这句话，用户看到的只会是"点了没反应"）；三种结果说三句不同的话；
    // 只认有 id 的帧，别的形状一律不理。
    let approve = null
    function approveShow(payload) {
      approve = { id: payload.id }
      $('approveTool').textContent = '它要让「' + (payload.toolName || '某个工具') + '」动手'
      $('approveReason').textContent = payload.reason || ''
      $('approveReason').style.display = payload.reason ? '' : 'none'
      // 命令原文：有就照原样显示。**没有就明说"没取到"，不静默藏起来**——
      // 用户要的就是看见命令，藏起来等于骗他；真没取到时他也一眼看得出是这条链没走通。
      $('approveCmd').textContent = payload.command || '（这条没取到命令原文）'
      $('approveCard').classList.add('on')
    }
    function approveDecide(allow) {
      if (!approve) return
      const id = approve.id
      sendApproval(id, allow).then(function (verdict) {
        if (verdict === 'failed') {
          toast('没送出去，看一眼和电脑的连接，再点一次')
          return
        }
        approve = null
        $('approveCard').classList.remove('on')
        if (verdict === 'late') toast('这条已经交回电脑了，去电脑上处理')
      })
    }
    $('approveAllow').addEventListener('click', function () { approveDecide(true) })
    $('approveDeny').addEventListener('click', function () { approveDecide(false) })
    es.addEventListener('approval', function (e) {
      let payload = null
      try { payload = JSON.parse(e.data) } catch (err) { return }
      if (!payload || !payload.id) return
      approveShow(payload)
    });
    es.addEventListener('question', function (e) {
      let payload = null
      try { payload = JSON.parse(e.data) } catch (err) { return }
      if (!payload || !payload.id || !Array.isArray(payload.questions) || !payload.questions.length) return
      // 同一道题已经显示着（轮询兜底先把它补出来了，或者服务端重连后又补发了一遍）：
      // **不要重建**，否则用户勾好的选项会被清掉。
      if (ask && ask.id === payload.id) return
      ask = { id: payload.id, questions: payload.questions, i: 0, picked: {}, custom: false }
      askRender()
    });
    // 心跳（服务端每 10 秒一帧）：**没有任何逻辑**，只为了让上面那层 stampFrames 记下一笔
    // 「这条流还活着」。少了它，空闲时 lastFrameAt 会一直变老，轮询兜底就会白开。
    es.addEventListener('tick', function () {});
    // 这道题在**别处**被答掉了（电脑上、飞书上），插件主动推一条状态过来。
    //
    // 没有这一条，卡片就干巴巴挂在屏幕上：用户在飞书里答完了，切回手机还看得见这道题，
    // 只能以为没生效、再答一次——那时候拿到的是「已经过期了」。所以这里就地收起来，
    // 并说一句它是怎么没的。**只在自己正显示着同一道题时动手**，别的题（编号对不上）
    // 一个字都不碰。
    //
    // 2026-11-27 晚：这条帧现在**带着答案**（`items`）。用户的要求是「选择后关闭卡片
    // 并显示选择了什么」，所以收卡的同时把「你选了 A、B」也画出来——一条立在聊天流里的
    // chip（见 rememberAnswer），外加一句 1.8 秒的即时提示（见 saySettled）。
    es.addEventListener('question-done', function (e) {
      let payload = null
      try { payload = JSON.parse(e.data) } catch (err) { return }
      if (!payload || !payload.id) return
      if (!ask || ask.id !== payload.id) return
      const id = ask.id
      closeAskCard()
      rememberAnswer(id, payload.items, payload.source)
      saySettled(payload.source, payload.items)
    });
    // 连上来时服务端补一份「题目现在的样子」：还在等哪些、刚收掉了哪几道（含结果）。
    //
    // 为什么需要它：上面那条 `question-done` 是**一次性**的。手机锁屏 / 切后台 / 换网络时
    // SSE 会断，而「电脑上答完了」那一下正好落在断线期间，那条帧就永远收不到，页面上这张卡
    // 会一直挂着（2026-11-27 用户实测）。这条每次连上都给一份，页面拿它对一次账。
    es.addEventListener('question-state', function (e) {
      let payload = null
      try { payload = JSON.parse(e.data) } catch (err) { return }
      reconcileAsk(payload)
    });
    /**
     * 用「服务端现在还挂着哪些题 / 刚收掉了哪几道」对一次账。
     *
     * 判据只有一条：**我手上这张卡，服务端还在等它吗**。还在等就一个字都不动（用户可能
     * 正勾着选项）；已经不在了就收掉，能从 `settled` 里认出结果就把「你选了 X」补出来。
     * 别的题（编号对不上）一律不碰。
     */
    function reconcileAsk(payload) {
      if (!ask || !payload) return
      const pending = Array.isArray(payload.pending) ? payload.pending : []
      for (let i = 0; i < pending.length; i++) {
        if (pending[i] && pending[i].id === ask.id) return
      }
      let settled = null
      const all = Array.isArray(payload.settled) ? payload.settled : []
      for (let j = all.length - 1; j >= 0; j--) {
        const one = all[j]
        if (one && one.kind === 'question' && one.id === ask.id) { settled = one; break }
      }
      const id = ask.id
      closeAskCard()
      if (settled) {
        rememberAnswer(id, settled.items, settled.source)
        saySettled(settled.source, settled.items)
      } else {
        // 认不出这道题去哪了（超出那 10 分钟的对账窗口）：只说"不在等你了"，不编结果。
        saySettled('', null)
      }
    }
    es.addEventListener('approval-done', function (e) {
      let payload = null
      try { payload = JSON.parse(e.data) } catch (err) { return }
      if (!payload || !payload.id) return
      if (!approve || approve.id !== payload.id) return
      approve = null
      $('approveCard').classList.remove('on')
      if (payload.source === 'feishu') toast('这条已经在飞书里处理过了')
    });
    es.addEventListener('status', function (e) {
      try { setRunning(JSON.parse(e.data).running); } catch (err) {}
    });
    es.addEventListener('error', function () {
      state.connected = false;
      updateStatusUI();
      $('connHint').textContent = '已断开，正在自动重连…';
      // EventSource 自己会重连，这里不用手动 close。
    });

    // ——— 轮询兜底 ———
    //
    // 有些公网通路（实测 quick tunnel 就是）会把整条 SSE **整段缓冲**：一条帧能压两三分钟，
    // 手机上于是完全不弹答题卡、正文也不更新，看着就是「卡住」。这条兜底不跟它抢：
    //   · SSE 正常时**一个请求都不发**：服务端每 10 秒有一帧 `tick`（见上面那个监听器），
    //     所以「上一帧不到 15 秒」就当它活着；刚连上还没收到任何东西时用 8 秒这个短窗口；
    //   · 判定为不通之后，才每 3 秒问一次 `/mini/api/ping`——只回「有没有待答的题」和一个 rev；
    //   · rev 变了 = 这段时间错过了事件，顺手拉一次 `/mini/api/state` 把整页补齐（最多 3 秒一次）；
    //   · 题目：有题在等而手机上没显示 → 直接把卡片弹出来；这张卡已经不在了（电脑上答了、
    //     或者被撤了）→ 自己收起来，不留一张点不动的卡。
    // 页面在后台（document.hidden）时一律不轮询：锁屏省电省流量，回来下一拍就补上。
    function pollTick() {
      if (document.hidden) return;
      // 还没轮询过（页面刚连上）时用更短的窗口：SSE 要是一开始就不通，别让人干等 15 秒
      // 才看见内容；正常情况下一帧 `state` 早就到了，这条判断根本走不到。
      var limit = pollRev === -1 ? POLL_FIRST_MS : POLL_STALE_MS;
      if (Date.now() - lastFrameAt < limit) return;
      api('/mini/api/ping').then(function (p) {
        if (!p || p.ok !== true) return;
        var list = Array.isArray(p.pending) ? p.pending : [];
        // ① 卡片已经不作数了：收起来——**顺带把「你选了什么」补出来**（见 reconcileAsk：
        //    服务端在这份 ping 里带着刚收摊的那几条结果，正是为了补这个）。
        if (ask && !list.some(function (x) { return x && x.id === ask.id; })) {
          reconcileAsk(p);
        }
        // ② 有题在等、手机上却没显示：补出卡片
        if (!ask) {
          for (var i = 0; i < list.length; i++) {
            var one = list[i];
            if (!one || !one.id || !Array.isArray(one.questions) || !one.questions.length) continue;
            ask = { id: one.id, questions: one.questions, i: 0, picked: {}, custom: false };
            askRender();
            break;
          }
        }
        // ③ 进度：rev 变了就是错过了帧，拉一份整页状态补齐。**一次只挂一个**，
        // 拉不回来就等下一拍，不叠请求。
        if (p.rev !== pollRev && !stateRefreshing && Date.now() - stateFetchedAt > STATE_MIN_GAP_MS) {
          stateRefreshing = true;
          stateFetchedAt = Date.now();
          var wantRev = p.rev;
          api('/mini/api/state').then(function (snap) {
            if (wantRev === pollRev) return;
            pollRev = wantRev;
            applySnapshot(snap);
          }).catch(function () {}).then(function () { stateRefreshing = false; });
        }
      }).catch(function () {});
    }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    pollTimer = setInterval(pollTick, POLL_EVERY_MS);
    pollTick();
  }

  // ---------------- 发送 ----------------
  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  }

  // ---------------- 斜杠指令（在输入框里打 / 时弹出来的菜单） ----------------
  //
  // 手机上敲 `/` 要能看见这个会话有哪些指令、点一下就执行。这一块管三件事：
  // 菜单怎么出（paintCmdMenu）、点一条怎么处理（pickCommand）、执行本身
  // （runCommand，下面 send 那条路也用它）。
  //
  // 数据**按会话缓存**，理由见 state 里 commands* 那几个字段。
  //
  // 输入框本来的提示语。选了一条「要参数」的指令时它会被换成那句 hint，发出去之后
  // 要换回来——留着上一个指令的参数提示，下一个普通问题就顶着一句不相干的话。
  var INPUT_HINT = inputEl.placeholder || '';

  /**
   * 输入框里那个「还没打完的指令」。
   *
   * 命中时返回 `/` 后面那一段（只打了一个 `/` 就是空串），没命中返回 null。
   * 判据收得很紧：**整行**必须正好是「/ 加一串小写字母数字下划线横线」。出现空格、
   * 前面多了别的字、用了大写，都算没命中——菜单收起来，交给 send 里那条分流规则。
   *
   * 只认小写是因为 DSH 的指令名就是小写：把大写也当命中，用户会看到「打了没反应」
   * （过滤出零条 → 菜单收起），而真实原因只是他开着大写。
   */
  function slashQuery() {
    var m = /^\/([a-z0-9_-]*)$/.exec(inputEl.value);
    return m ? m[1] : null;
  }

  function hideCmdMenu() {
    var el = $('cmdMenu');
    if (!el) return;
    el.hidden = true;
    el.innerHTML = '';
  }

  /** 这个会话的指令表是不是还没有（或者需要重取）。 */
  function needCommands() {
    // 换了会话就得重取，见 state 里 commands* 的说明。
    if (state.commandsFor !== state.boundSessionId) return true;
    // 这个会话还什么都没拿到、也没失败过——第一次用到它的时候去取。
    return !state.commands && !state.commandsError;
  }

  function loadCommands() {
    // 正在取就别再发一次：菜单是跟着输入框每敲一个字重画的，不拦着的话
    // 打「/compact」会连发八个请求。
    if (state.commandsLoading) return;
    state.commandsLoading = true;
    // 记下这份数据是**给哪个会话**取的，而不是「请求是什么时候发的」——
    // 请求飞在路上时用户完全可能已经切走了，回来那一份就不作数了。
    var forSession = state.boundSessionId;
    state.commands = null;
    state.commandsError = '';
    api('/mini/api/commands').then(function (res) {
      state.commandsLoading = false;
      if (forSession !== state.boundSessionId) return;   // 不是这个会话的，扔掉
      state.commandsFor = forSession;
      if (res && res.ok) {
        state.commands = res.commands || [];
        state.commandsError = '';
      } else {
        // 服务端给了原因（多半是「这个会话现在没在跑」）就原样留着显示。
        // **不能显示成空列表**：那等于说「这个会话没有指令」，是另一回事。
        state.commandsError = (res && res.error) || '读不到指令列表';
      }
      paintCommandViews();
    }).catch(function (err) {
      state.commandsLoading = false;
      if (forSession !== state.boundSessionId) return;
      state.commandsFor = forSession;
      state.commands = null;
      state.commandsError = err.message || '读不到指令列表';
      paintCommandViews();
    });
  }

  /**
   * 指令表换了一份之后，**所有正在看着它的地方**都要重画。
   *
   * 现在有两处：打 / 弹出来的菜单，和统一操作面板里的那个列表。回调那一个由面板
   * 那一段自己挂上——因为它在这一段下面，而这一段会被测试单独抠出来跑（那时面板还不存在）。
   */
  var onCommandsReady = null;
  function paintCommandViews() {
    paintCmdMenu();
    if (onCommandsReady) onCommandsReady();
  }

  /**
   * 画（或收起）那只菜单。
   *
   * 它**每回都按输入框重算**，自己不记「现在是开着还是关着」：这样就不会出现
   * 「菜单和输入框对不上」的状态——比如程序清空输入框（点菜单、发完之后）不会触发
   * input 事件，那种时候没人替我们收菜单，只能自己出面对齐。
   */
  function paintCmdMenu() {
    var el = $('cmdMenu');
    if (!el) return;
    // 输入框被清空了 = 用户把刚才那条指令整个删了，这是「明确取消」那一步。
    // 放在这儿而不是 send() 里：清空之后他往往还要改写成普通提问，那次 send 不该再被拦。
    if (!inputEl.value.trim()) state.pendingCommand = null;
    var prefix = slashQuery();
    if (prefix === null) { hideCmdMenu(); return; }
    var wasOpen = !el.hidden;
    // 上次没取到时，**每次重新打开可以再试一次**（关着→打开这一下才重取，不是每敲一个
    // 字都取）。这一条是必须的：失败的原因多半是「这个会话现在没在跑」，而用户完全可能
    // 随后就发了条消息让它跑起来——那时再打 /，看到的却是上一句已经过时的话，
    // 他会以为这个功能坏了。
    if (needCommands() || (!wasOpen && state.commandsError)) loadCommands();
    el.hidden = false;
    if (state.commandsError) {
      el.innerHTML = '<div class="cmd-note">' + escapeHtml(state.commandsError) + '</div>';
      return;
    }
    if (!state.commands) {
      // 取回来之前先占个位——不然敲了 / 什么都不发生，看着像坏了。
      el.innerHTML = '<div class="cmd-note">正在读取可用的指令…</div>';
      return;
    }
    var rows = state.commands.filter(function (c) {
      return String(c.name || '').indexOf(prefix) === 0;
    });
    // 一条都对不上就收起来，**不写「没有匹配的指令」**：用户还在打字，打到一半没有
    // 匹配是常事，插一句提示只是噪音。真打错了指令，按发送时会被明确拒绝并说明。
    if (!rows.length) { hideCmdMenu(); return; }
    el.innerHTML = rows.map(function (c) {
      return '<button class="cmd-row" type="button" data-cmd="' + escapeHtml(c.name) + '">'
        + '<span class="cmd-name">/' + escapeHtml(c.name) + '</span>'
        + '<span class="cmd-desc">' + escapeHtml(c.description || '') + '</span></button>';
    }).join('');
  }

  /**
   * 菜单/面板里点了一条。
   *
   * 分两路，判据是服务端给的 hint（这条指令要不要参数）。两路都**不执行**，
   * 除非是打了 / 之后从菜单里点了一条不要参数的（那种当场跑，见 deferRun 的说明）：
   *   · 不要参数 —— 直接执行。让用户再按一次发送是白白多一步。
   *   · 要参数   —— 把 `/名字 ` 填进输入框，末尾留一个空格、光标停在后面，并把
   *     hint 那句话挂到输入框的 placeholder 上。
   *     **不自己编一句「请输入参数」**：只有服务端知道这条指令要什么，
   *     编一句就等于让用户照着一个错的提示去填。
   *
   * @param {string} name
   * @param {boolean} [deferRun] 面板那条路传 true：**一次点击不执行**，只把这一行放进
   *   输入框，由「发送」那一下确认（没有参数提示的指令也照此办理，宁可多问一句）。
   *   打 / 弹出来的那个菜单不传——它本来就是「扫一眼挑一个」，多一步反而碍事。
   */
  function pickCommand(name, deferRun) {
    var list = state.commands || [];
    var cmd = null;
    for (var i = 0; i < list.length; i++) { if (list[i].name === name) cmd = list[i]; }
    if (!cmd) return;
    hideCmdMenu();
    // 先把提示语还原，再按这一条决定要不要挂 hint——不然上一次点的那条「要参数」的
    // 指令留下的提示，会跟到这一条（不需要参数的）头上。
    inputEl.placeholder = INPUT_HINT;
    if (cmd.hint) {
      inputEl.value = '/' + cmd.name + ' ';
      inputEl.placeholder = cmd.hint;
      // 这一行「曾经是一条指令」：名字要是被删掉，send 不许拿它当普通提问发出去。
      state.pendingCommand = cmd.name;
      inputEl.focus();
      // 光标停在最后：停在名字中间的话，用户接着打的字会插进名字里去。
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      autoGrow();
      return;
    }
    if (deferRun) {
      // 面板那条路：只填不跑。等用户按「发送」——那就是明确的确认执行动作。
      inputEl.value = '/' + cmd.name;
      state.pendingCommand = cmd.name;
      inputEl.focus();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      autoGrow();
      return;
    }
    // 当场执行：框里不留东西，也就不存在「曾是指令」这回事。
    state.pendingCommand = null;
    inputEl.value = '';
    autoGrow();
    runCommand('/' + cmd.name);
  }

  /**
   * 执行一条斜杠指令。
   *
   * 和普通消息走的是**两条不同的接口**：/mini/api/command 收的是完整的一行（含 /
   * 和参数），/mini/api/send 收的是「发给模型的一句话」。手机这边不替用户猜他打的是
   * 哪一个——猜错的代价是一次真花掉额度的提问，而且电脑端对不存在的指令是明确拒绝的，
   * 两边行为得一致。
   *
   * 接口只回一个 ok：这条指令**存不存在、跑得怎么样，都不在这里**。开始和结果由会话
   * 事件推回来（历史里出现 role:'command' 的条目，kind 从 running 变 success/error）。
   * 所以这里既不做乐观显示（会跟推来的那条重一份），也不报喜——只把「当场被拒」
   * 这一种情况说出来。
   */
  function runCommand(line) {
    api('/mini/api/command', { method: 'POST', body: JSON.stringify({ line: line }) })
      .then(function (res) {
        if (res && res.ok) return;
        // 被拒（没有这条指令 / 语法不对）的原因必须让用户看见，不能悄悄咽掉。
        toast((res && res.error) || '这条指令没跑起来');
      })
      .catch(function (err) { toast(err.message || '这条指令没跑起来'); });
  }

  $('cmdMenu').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-cmd]') : null;
    if (btn) pickCommand(btn.getAttribute('data-cmd'));
  });

  // ---------------- 上传附件 ----------------
  /** 把字节数说成人话。 */
  function humanSize(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function setAttachBusy(busy) {
    var btn = $('btnAttach');
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('busy', busy);
  }

  /**
   * 把选中的文件传到电脑上。
   *
   * 文件本身直接当请求体发（fetch 支持把 File 当 body），不走 JSON、不做 base64——
   * base64 会把体积撑大三分之一，而这条路可能是手机流量。电脑那边是边收边落盘，
   * 不在内存里攒整份。
   *
   * 传完只拿回一张小票（uploadId）。真正的附件已经在电脑上了，手机上不留副本。
   */
  function uploadFile(file) {
    var name = file.name || '文件';
    // 本地上限和服务端是同一个数（由服务端注入），先拦一道省得白传一场。
    if (MAX_UPLOAD > 0 && file.size > MAX_UPLOAD) {
      toast('「' + name + '」有 ' + humanSize(file.size) + '，超过上限 ' + humanSize(MAX_UPLOAD));
      // 多选时是排队传的（见 filePick 的 change），所以这里也要回一个「承诺」——
      // 否则这一份被拦下会让整条链断掉，后面几张就再也传不出去了。
      return Promise.resolve();
    }
    setAttachBusy(true);
    // 返回这条链：多选时调用方靠它排队（一张传完再传下一张）。
    return api('/mini/api/upload?name=' + encodeURIComponent(name) + '&size=' + file.size,
      { method: 'POST', body: file })
      .then(function (res) {
        state.uploads.push({ uploadId: res.uploadId, name: res.name, bytes: res.bytes });
        renderAttach();
      })
      .catch(function (err) {
        toast(err.message || '上传失败');
      })
      .then(function () { setAttachBusy(false); });
  }

  /**
   * 附件小条。有东西才出现，没有就整块收起来——不占地方。
   *
   * 统一操作面板里那几行「已选文件」是**同一份数据、同一份 HTML**：都由这里画，
   * 都读 state.uploads。别在面板里另存一个附件数组——那样两处迟早对不上
   * （面板里删了一条，小条还挂着，用户就不知道该信哪个）。
   */
  function renderAttach() {
    var bar = $('attachBar');
    if (!bar) return;
    var list = state.uploads || [];
    var chips = list.map(function (f, i) {
      return '<span class="chip"><span class="nm">' + escapeHtml(f.name) + '</span>'
        + '<span class="sz">' + humanSize(f.bytes) + '</span>'
        + '<button class="x" type="button" data-drop="' + i + '" aria-label="去掉">×</button></span>';
    }).join('');
    bar.hidden = !list.length;
    bar.innerHTML = chips;
    var box = $('opsFiles');
    if (box) { box.hidden = !list.length; box.innerHTML = chips; }
  }

  /**
   * 去掉一条已选文件。小条和面板共用这一处，别写两份。
   *
   * 编号必须从**被点的按钮**上读（`closest('[data-drop]')`），不能读 e.target：
   * ✕ 是按钮里那个图形，手指落上去 e.target 就是图形本身，读它只能拿到 null，
   * 于是静默什么都不做（2026-09-28 实机报过的那个 bug）。
   */
  function dropUpload(btn) {
    state.uploads.splice(Number(btn.getAttribute('data-drop')), 1);
    renderAttach();
  }

  function send() {
    var text = inputEl.value.trim();
    var files = state.uploads || [];
    // 跑着的时候**照样能发**。原来这里有个 `|| state.running` 直接 return，
    // 于是手机上「正在跑就发不了」，只能干等；而 DSH 本身在跑着的时候是收的——
    // 那条会排进收件箱，等当前这一轮结束再跑。现在只是把「不许发」改成「排队」。
    //
    // 只带文件、一个字不写也是合法的：「这份文件你看一下」本来就是常见用法。
    // 两样都没有才算空。
    if (!text && !files.length) return;

    // **点过指令、又把名字删掉的那一行，不许当普通提问发出去。**
    //
    // 从面板/菜单点了一条「要参数」的指令之后，输入框里躺着 `/名字 参数`。用户要是把
    // 名字删了、只留参数，这一行就不再以 / 开头，原来会被当成一次普通提问发给模型——
    // 白花一次额度，而且他还以为自己跑的是那条指令。
    //
    // 拦在**清空输入框之前**：那一行字要留着，补回名字就能接着发。出路有两条，
    // 都在提示里说清楚了：补回开头的指令名，或者清空输入框（清空 = 明确取消这条指令，
    // 由 paintCmdMenu 在每次输入时把那枚标记撤掉）。
    if (text.charAt(0) !== '/' && state.pendingCommand) {
      toast('这是 /' + state.pendingCommand + ' 的参数，指令名被删掉了。'
        + '把 /' + state.pendingCommand + ' 补回开头，或者清空输入框改问别的。');
      return;
    }
    unlockAudio();
    // **发指令这个动作，无条件拉回底部。**
    //
    // 用户 2026-09-22 实机提的：「用户发送指令时，如果在手机端页面比较上面的位置，
    // 应该马上下滚回底部。」
    //
    // 这跟 atBottom 那条规则不冲突，两者管的不是一件事：那条管的是**页面自己在动**
    // （鲸鱼娘在跳、流式在写），别把正在翻历史的用户拽回来；这条管的是**用户自己按了发送**，
    // 那是主动动作，他想看自己刚发出去的那条、以及后面的回答，所以不管当时翻到哪儿都回底部。
    //
    // 位置有讲究：必须放在 setRunning 之前。setRunning 会触发一次渲染，而渲染里的
    // atBottom() 是在改内容**之前**问的——先滚到底，那次渲染才会认为「本来就在底部」
    // 而继续跟着走；顺序反了，刚回到底部又会被那次渲染判成「用户翻上去了」而停在原地。
    mainEl.scrollTop = mainEl.scrollHeight;
    inputEl.value = '';
    autoGrow();
    // 输入框空了，菜单得当场收起来：清空是程序改的 value，不会触发 input 事件，
    // 没人替我们重算，菜单就会挂在那儿配着一个空输入框。
    hideCmdMenu();
    inputEl.placeholder = INPUT_HINT;

    // **以 / 打头的走指令那条路，不再当普通消息发。**
    //
    // 这是用户拍板的：手机上打了一条不存在的指令，要跟电脑端一样被明确拒绝并说明原因，
    // 不能悄悄当成一次提问发给模型——那既让两边行为不一致，又等于把一次敲错变成一次
    // 真花掉额度的提问。
    //
    // 存不存在由服务端判（这边的指令表可能是缓存的旧值），所以这里不看列表，
    // 只认「trim 之后第一个字符是不是 /」。
    if (text.charAt(0) === '/') {
      // 附件跟不过去：指令接口收的只有那一行（见 runCommand 的说明）。
      // 这里**不动 state.uploads**——清掉就等于把用户刚传上来的文件悄悄扔了，
      // 而他还以为跟着发出去了。留在小条上看得见，想发就配一句话再发一次。
      if (files.length) toast('指令带不了附件，附件还留在下面');
      // 跑出去了，那枚「曾是指令」的标记就该撤掉：留着会拦住下一条普通提问。
      state.pendingCommand = null;
      runCommand(text);
      return;
    }

    var uploadIds = files.map(function (f) { return f.uploadId; });
    // 手机上先把附件收起来：小票已经交出去了，留着会让用户以为还能再发一次。
    state.uploads = [];
    renderAttach();
    // 聊天模式要在本地回显一条。附件也得看得见——不然发完一条只有文件、没写文字的
    // 指令，气泡是空的，用户会以为没发出去。
    var shown = files.length
      ? text + (text ? '\n' : '') + '📎 ' + files.map(function (f) { return f.name; }).join('、')
      : text;

    if (state.mode === 'minimal') {
      // 上一条回答**留着**，由 renderMinimal 在它下面加一条「正在执行」。
      // 原来这里把 latest 清成 null，加上渲染顺序，结果是发完指令旧结果整块消失。
      // 旧的顾虑（怕用户把上一轮的结果当成这次任务的回复）现在由那条分隔线解决：
      // 它明确标出「下面是正在跑的，上面是上一步的」。
      render();
    }
    setRunning(true);

    api('/mini/api/send', { method: 'POST', body: JSON.stringify({ text: text, uploadIds: uploadIds }) })
      .then(function (res) {
        // 服务端说这条排队了 / 插话了（发的时候正在跑），给一句话。
        // 队列那块也会跟着推过来，但那要等一个来回；先给个即时反馈，
        // 免得用户以为又石沉大海了。
        //
        // **两条要说不同的话**（2026-10-06）：插话是「下一个步骤边界就取走」，
        // 通常几秒；排队是「等这一轮跑完」，可能好几分钟。都回一句「已排队」
        // 就等于把插话也说成了排队——用户就是这么发现「插话好像没实现」的。
        if (res && res.steered) {
          toast('已插话，它下一步就看到');
          return;
        }
        if (res && res.queued) {
          toast('已排队，跑完这轮就轮到它');
          // **排队不算发出去，所以这里不回显气泡。** 用户 2026-09-22 实机提的：
          // 排队的指令立刻长成一条指令气泡，看着就像已经发出去了，其实还在队列里。
          // 它已经在下面的排队列表里露过面了，那就是它此刻该待的地方；
          // 轮到它真跑起来时，服务端会把它记进 history，气泡那时才出现。
          // 插话走的是同一条账（等它真被取走时才长气泡），所以这里一起 return。
          return;
        }
        // 真发出去了才回显。放在这里而不是发之前，是因为**发之前还不知道会不会排队**；
        // 顺带也解决了发送失败时屏幕上留一条假气泡的问题。
        if (state.mode !== 'minimal') {
          state.history = (state.history || []).concat([
            { role: 'user', text: shown, timestamp: Date.now(),
              // 完整模式把轨迹块插回对话原位要用：从轨迹中取当前轮号。
              // 手机本地回显时轮还没开，先留空；服务端快照补上来时会带上真轮号。
              turn: currentTrajectoryTurn() }
          ]);
          render();
        }
      })
      .catch(function (err) {
        setRunning(false);
        if (state.mode === 'minimal') render();
        toast(err.message || '发送失败');
        inputEl.value = text;
        autoGrow();
        // 附件也还回来。不然网络抖一下，用户刚传上去的文件就白传了，得重新选一次——
        // 而重新选一次意味着重新传一遍。
        state.uploads = files;
        renderAttach();
      });
  }

  // ---------------- 统一操作面板（输入框旁边那一个入口） ----------------
  //
  // 形态是用户 2026-10-02 定的：输入框旁边**一个**入口，点开是一张底部抽屉，
  // 上面「添加文件」、下面「调用指令」。原来这两件事各有各的门——回形针直接开文件
  // 选择器、打 `/` 才弹指令菜单——手机上没人知道打一个斜杠还能调指令。
  //
  // 四条复用纪律（都不许另起一套）：
  //   · 外壳 = 设置抽屉那一套（#settings.open + .sheet），不新建样式体系；
  //   · 指令数据 = state.commands 那份按会话缓存，与打 / 弹出来的菜单**同一份**，
  //     判据也共用 needCommands()，不写「面板专用」的第二套；
  //   · 指令行 = 现成的 pickCommand(name, true)，一次点击**不执行**；
  //   · 附件 = state.uploads + renderAttach()，面板里那几行就是小条那几行。
  //
  // 「指令带附件一起发」这一轮**不做**（手机的上传小票 DSH 的指令接口不认，见 onCommand
  // 那段说明）——所以对声明了要附件的指令，面板上如实标一句「手机暂时带不了附件」，
  // 不假装支持。
  var ops = $('ops');
  // 面板是不是开着。指令表换一份时要按它决定要不要重画列表（见 paintCommandViews）。
  var opsOpen = false;

  function openOps() {
    opsOpen = true;
    // 先把键盘收起来：这张抽屉贴着底边，键盘不收，它就被顶到看不见的地方。
    if (inputEl.blur) inputEl.blur();
    ops.classList.add('open');
    // 与打 / 时同一个判据：换了会话要重取，上次没取到过就再试一次。
    if (needCommands() || state.commandsError) loadCommands();
    paintOps();
  }

  function closeOps() {
    opsOpen = false;
    ops.classList.remove('open');
  }

  /**
   * 画面板里的指令列表。
   *
   * 和打 / 那个菜单同源（state.commands），但这里是「搜」不是「按前缀」：面板上那个框是
   * 一句话搜索框，名字和说明都匹配（桌面端也是名字和标题一起匹配）。顺手带个 `/c` 也算，
   * 那是用户平时打指令的手势。
   *
   * **取不到就说原因**，不显示成「一条都没有」——两件事，用户能做的也不同。
   */
  function paintOps() {
    var listEl = $('opsCmds');
    if (!listEl) return;
    if (state.commandsError) {
      listEl.innerHTML = '<div class="cmd-note">' + escapeHtml(state.commandsError) + '</div>';
      return;
    }
    if (!state.commands) {
      // 取回来之前先占个位——不然打开面板是一片空白，看着像坏了。
      listEl.innerHTML = '<div class="cmd-note">正在读取可用的指令…</div>';
      return;
    }
    var filterEl = $('opsFilter');
    var q = String((filterEl && filterEl.value) || '').trim().toLowerCase();
    if (q.charAt(0) === '/') q = q.slice(1);
    var rows = state.commands.filter(function (c) {
      if (!q) return true;
      return (String(c.name) + ' ' + String(c.description || '')).toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) {
      listEl.innerHTML = '<div class="cmd-note">没有对得上的指令。</div>';
      return;
    }
    listEl.innerHTML = rows.map(function (c) {
      return '<button class="cmd-row" type="button" data-cmd="' + escapeHtml(c.name) + '">'
        + '<span class="cmd-top">'
        + '<span class="cmd-name">/' + escapeHtml(c.name) + '</span>'
        + '<span class="cmd-desc">' + escapeHtml(c.description || '') + '</span>'
        + '</span>'
        + (c.attachments ? '<span class="cmd-flag">手机暂时带不了附件</span>' : '')
        + '</button>';
    }).join('');
  }

  // 面板里点一行：**一次点击不执行**（deferRun）。要参数的把 hint 挂成占位提示、把
  // `/名字 ` 填进输入框；不要参数的也只填进去，等「发送」那一下——宁可多问一句，
  // 也不能点错一下就真跑掉。
  $('opsCmds').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-cmd]') : null;
    if (!btn) return;
    closeOps();
    pickCommand(btn.getAttribute('data-cmd'), true);
  });

  $('opsFilter').addEventListener('input', paintOps);
  $('opsClose').addEventListener('click', closeOps);
  // 点抽屉外面那一层 = 关掉（和设置抽屉同一条规矩）。
  ops.addEventListener('click', function (e) { if (e.target === ops) closeOps(); });

  // 「添加文件」两件事：选文件、拍照。都走原来那个藏起来的 #filePick——手机上这两件事
  // 本来就是同一个系统选择器，区别只在「要不要限定图片、要不要调后置摄像头」。
  //
  // **多选只给「选文件」**（2026-10-05 用户要求：图库和文件里只能单选，改成多选）。
  // 拍照那一条不加 multiple：相机一次就出一张，摆个多选没有意义。
  function openFilePicker(camera) {
    var pick = $('filePick');
    if (!pick) return;
    if (camera) {
      pick.setAttribute('accept', 'image/*');
      pick.setAttribute('capture', 'environment');
      pick.removeAttribute('multiple');
    } else {
      pick.removeAttribute('accept');
      pick.removeAttribute('capture');
      pick.setAttribute('multiple', '');
    }
    pick.click();
  }
  $('opsPick').addEventListener('click', function () { openFilePicker(false); });
  $('opsShot').addEventListener('click', function () { openFilePicker(true); });

  // 面板里那行已选文件上的 ✕。走的是和小条同一个 dropUpload()。
  $('opsFiles').addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-drop]') : null;
    if (!btn) return;
    dropUpload(btn);
  });

  // 指令表换了一份（换会话、第一次取到）时，面板开着就跟着重画。
  onCommandsReady = function () { if (opsOpen) paintOps(); };

  $('btnAttach').addEventListener('click', function () { openOps(); });
  $('filePick').addEventListener('change', function (e) {
    // 多选：一次可能挑了好几张，**一个接一个传**（2026-10-05 用户要求多选）。
    // 为什么不用并发：上传的「忙碌」是同一个开关（setAttachBusy 控制那个回形针），
    // 并发传的话最后一个传完就把按钮放开了，其实还有在飞的——用户会以为传完了。
    // 排队传则从头到尾都是忙的，什么时候能再点一目了然。
    var files = Array.prototype.slice.call(e.target.files || []);
    // 清掉 value：不清的话，连着选同一个文件第二次不会触发 change，
    // 用户会觉得「点了没反应」。
    e.target.value = '';
    if (!files.length) return;
    // **选完就回主页面**（2026-10-05 用户要求：选完文件点完成，直接回到主页面，
    // 不要停在这张「添加文件」面板上）。
    // 关在这里是安全的：文件是**后台在传**的，主页面上的附件小条会一条条冒出来；
    // 面板里那几行「已选文件」本来也只是同一份数据的另一处画法（见 renderAttach），
    // 关掉面板不会打断上传。
    closeOps();
    files.reduce(function (chain, f) {
      return chain.then(function () { return uploadFile(f); });
    }, Promise.resolve());
  });
  $('attachBar').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-drop]') : null;
    if (!btn) return;
    dropUpload(btn);
  });

  $('btnSend').addEventListener('click', send);

  inputEl.addEventListener('input', autoGrow);
  // 每敲一个字重算一次菜单。它自己会先看「是不是一个没打完的 / 名字」再决定动不动，
  // 所以这里不用加判据。
  inputEl.addEventListener('input', paintCmdMenu);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // ---------------- 语音输入：已移除 ----------------
  //
  // 输入框旁边原来有个 🎤，走的是浏览器的 SpeechRecognition。它在手机上**用不了**：
  // 浏览器把语音识别和 getUserMedia 一样限制在安全上下文里，而本插件三条连接路径
  // （内网 / Tailscale / 隧道未开）全是明文 http://。依据见 W3C bug 30176：
  // https://www.w3.org/Bugs/Public/show_bug.cgi?id=30176
  //
  // 更糟的是浏览器把这种情况报成 `not-allowed`，和「用户拒绝了权限」同一个错误码，
  // 于是用户看到的是「麦克风权限被拒绝」，去浏览器设置里翻也找不到能改的东西。
  //
  // 2026-09-21 用户裁决：**拿掉这个图标**。留着按了没用，比没有更糟。
  // 想用说的，用手机键盘自带的 🎤 听写键——不挑连接、不要权限，设置里也写了这一句。
  // 别把它加回来，除非先有了一条受信任的 https 路径（比如开了证书的 tailscale serve）。

  // ---------------- 设置 ----------------
  var sheet = $('settings');
  $('btnSettings').addEventListener('click', function () {
    sheet.classList.add('open');
    $('connHint').textContent = state.connected ? '已连接' : '未连接';
    // 权限档位那块也在这儿重读一次：它显示的是「现在在哪一档」的实时状态（电脑端
    // 随时能改），而且启动时那一次要是没读成，不重读就整块再也不出现。
    loadPermissions(state.boundSessionId);
    // 版本号那行也现读一次：它只在设置页里看得见，没必要开机就为它跑一趟。
    // （watchBuild 是同一个 script 块里的函数声明，这里调得到。）
    watchBuild();
    // 繁忙时的发送行为也现读一次：**电脑上随时能改**，开机读那一次会过期。
    loadBusyEnter();
    // 进阶设置（电脑端界面）同样现读。它还会被电脑端从小标签关掉——
    // 手机上那份状态不能一直停在「开着」。
    loadMirror();
  });
  $('btnClose').addEventListener('click', function () { sheet.classList.remove('open'); });
  // 顶部吸顶那个关闭口（2026-10-05 设置页改整屏时加的）。
  $('btnSettingsClose').addEventListener('click', function () { sheet.classList.remove('open'); });
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.classList.remove('open'); });

  // ---------------- 子智能体 ----------------
  //
  // 数据全从 /mini/api/subagents 那三条来（见 lib/server.js）。三条都在电脑上的
  // **同一个进程里直接问 DSH**，不经过 WebSocket——靠进程里这层关系拿到的东西
  // （清单、某一道自己的运行记录）反而比桌面前端更直接：桌面那边只能隔着一条
  // 只开了两个口子的线路，清单和记录得靠投影另推一份过来。
  //
  // 两条纪律，和主会话一模一样：**读不到就说读不到，不编**；**数字算不出来就空着**。
  var saPanel = $('subagents');
  var saRows = [];        // 最近一次读到的清单，点行时按 id 找回来
  var saCurrent = null;   // 正在看运行记录的那一道；null = 现在在看清单
  var saCache = null;
  var saCacheSession = null;
  var saCacheAt = 0;
  var saInflight = null;
  var SA_CACHE_TTL = 5000;

  function saToList() {
    saCurrent = null;
    $('subagentsDoc').hidden = true;
    $('subagentsList').hidden = false;
    $('subagentsBack').hidden = true;
    $('subagentsTitle').textContent = '子智能体';
  }
  function saToDoc(row) {
    saCurrent = row;
    $('subagentsList').hidden = true;
    $('subagentsDoc').hidden = false;
    $('subagentsBack').hidden = false;
    $('subagentsTitle').textContent = row.label || shortSessionId(row.id);
  }

  /** 用量（token 数）。读不到就是 null，页面上写「—」——写 0 会被读成「一次都没跑过」。 */
  function saTokens(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1000000).toFixed(1) + 'M';
  }
  /** 耗时。同样：读不到写「—」。 */
  function saDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  }
  /** 目录读不动的那三种原因，翻成人话。认不出来就照原样说，不编一个像样的理由。 */
  function saReason(r) {
    if (r === 'corrupt') return '那一支的目录坏了';
    if (r === 'unsupported') return '那条记录是更新的格式，这个版本读不了';
    return '那一支暂时读不到（' + r + '）';
  }

  function saRowHtml(s) {
    // 有一支目录读不动：DSH 会以一行「诊断」如实说原因。这里也如实转达，
    // 不假装那一支里没有人——吞掉的表现是「明明有子代理却一个都不显示」。
    if (s.diagnostic) {
      return '<div class="sa-row sa-plain"><span class="dot err"></span>'
        + '<span class="sa-main"><span class="sa-name">有一支读不出来</span>'
        + '<span class="sa-sub">' + escapeHtml(saReason(s.diagnostic)) + '</span></span></div>';
    }
    // 状态点用既有 .dot，和顶栏那颗同一套：在跑 = run；没在跑但最近跑完过 = ok；
    // 其余 = 灰。**没有动画**——那圈呼吸闪动在规格里已经被砍掉了（见 .dot 的注释）。
    var dot = s.running ? 'dot run' : (s.lastTurnCompleted ? 'dot ok' : 'dot');
    var kind = s.mode === 'continuable' ? '可续接' : '一次性';
    return '<button class="sa-row" type="button" data-sa="' + escapeHtml(s.id) + '">'
      + '<span class="' + dot + '"></span>'
      + '<span class="sa-main"><span class="sa-name">' + escapeHtml(s.label || shortSessionId(s.id)) + '</span>'
      + '<span class="sa-sub">' + kind + ' · ' + (s.running ? '在跑' : '已结束') + '</span></span>'
      + '<span class="sa-num">' + saTokens(s.tokens) + '<br>' + saDuration(s.durationMs) + '</span>'
      + '</button>';
  }

  function saRenderList(body) {
    var listEl = $('subagentsList');
    // 这两句空态都落在 .sa-list 里，而那个容器用负 16px 把内容拽到贴屏边
    // （为了让分隔线横贯整屏）——所以得补上 sa-none-indent 把 16px 加回来，
    // 否则这行字会顶到屏幕最左边。这个类是早就写好的，之前没给空态用上。
    if (!body || !body.ok) {
      listEl.innerHTML = '<div class="sa-none sa-none-indent">'
        + escapeHtml((body && body.error) || '读不到子智能体。') + '</div>';
      return;
    }
    saRows = body.subagents || [];
    if (!saRows.length) {
      listEl.innerHTML = '<div class="sa-none sa-none-indent">这个会话还没有派出过子智能体。</div>';
      return;
    }
    listEl.innerHTML = saRows.map(saRowHtml).join('');
    var btns = listEl.querySelectorAll('[data-sa]');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () { saOpenDoc(btn.getAttribute('data-sa')); });
      })(btns[i]);
    }
  }

  function saLoad(force) {
    var sessionId = state.boundSessionId || '';
    if (!force && saCache && saCacheSession === sessionId && Date.now() - saCacheAt < SA_CACHE_TTL) {
      saRenderList(saCache);
      return;
    }
    if (!force && saInflight && saInflight.sessionId === sessionId) return;
    $('subagentsList').innerHTML = '<div class="sa-none sa-none-indent">正在读取…</div>';
    var request = api('/mini/api/subagents');
    saInflight = { sessionId: sessionId, request: request };
    request.then(function (body) {
      if (state.boundSessionId === sessionId && body && body.ok) {
        saCache = body;
        saCacheSession = sessionId;
        saCacheAt = Date.now();
      }
      saRenderList(body);
    }).catch(function (err) {
      $('subagentsList').innerHTML = '<div class="sa-none sa-none-indent">'
        + escapeHtml(err && err.message || '没读出来。') + '</div>';
    }).finally(function () {
      if (saInflight && saInflight.request === request) saInflight = null;
    });
  }

  // 连接后趁页面空闲预取当前会话的子代理清单。首次读取可能很慢，不能把这段等待
  // 放到用户点入口之后；入口点击时会复用 saInflight，和导航工作区同一套策略。
  function prefetchSubagents() {
    var sessionId = state.boundSessionId || '';
    if (!sessionId || saCacheSession === sessionId || saInflight) return;
    var request = api('/mini/api/subagents');
    saInflight = { sessionId: sessionId, request: request };
    request.then(function (body) {
      if (state.boundSessionId !== sessionId || !body || !body.ok) return;
      saCache = body;
      saCacheSession = sessionId;
      saCacheAt = Date.now();
      if (saPanel.classList.contains('open') && !saCurrent) saRenderList(body);
    }).catch(function () {
      // 预取失败不影响入口；用户点开时仍会重试。
    }).finally(function () {
      if (saInflight && saInflight.request === request) saInflight = null;
    });
  }

  /** 点开某一道：换成它**自己的运行记录**（和主会话同一套重放，见 lib/history.js）。 */
  function saOpenDoc(childId) {
    var row = null;
    for (var i = 0; i < saRows.length; i++) if (saRows[i].id === childId) row = saRows[i];
    if (!row) return;
    saToDoc(row);
    $('subagentsDoc').innerHTML = '<div class="sa-none">正在读取它的记录…</div>';
    api('/mini/api/subagent?id=' + encodeURIComponent(childId)).then(function (body) {
      // 读的过程中用户可能已经返回、或点开了另一道——那这一份就别再往上贴了。
      if (saCurrent !== row) return;
      saRenderDoc(body);
    }).catch(function (err) {
      if (saCurrent !== row) return;
      $('subagentsDoc').innerHTML = '<div class="sa-none">'
        + escapeHtml(err && err.message || '没读出来。') + '</div>';
    });
  }

  /** 运行记录里的一条。长相和主会话**完全一样**：气泡/正文/指令行/完工卡片共用同一批样式。 */
  function saEntryHtml(e) {
    if (e.role === 'notice') return noticeBlock(e);
    if (e.role === 'command') return commandBlock(e);
    if (e.role === 'user') {
      return '<div class="bubble user">' + escapeHtml(e.text || '')
        + '<span class="meta">' + timeLabel(e.timestamp) + '</span></div>';
    }
    return '<div class="said"><div class="md">' + mdToHtml(e.text || '') + '</div>'
      + '<div class="reply-foot"><span class="time">' + timeLabel(e.timestamp) + '</span></div></div>';
  }

  function saRenderDoc(body) {
    var docEl = $('subagentsDoc');
    if (!body || !body.ok) {
      docEl.innerHTML = '<div class="sa-none">'
        + escapeHtml((body && body.error) || '没读出来。') + '</div>';
      return;
    }
    var html = '';
    if (body.reclaimed) {
      // 一次性子智能体跑完、记录已经被回收：**如实说没有记录**，不拿它冒充
      // 「它没干过活」——那两件事对用户含义不同。
      html += '<div class="sa-none">它的运行记录已经不在电脑上了，'
        + '只能看到它当时发回来的那条完工通知。</div>';
    } else if (!body.entries || !body.entries.length) {
      html += '<div class="sa-none">它还没有任何记录。</div>';
    } else {
      if (body.truncated) {
        html += '<div class="history-note">'
          + escapeHtml(body.note || '只显示最近一段。') + '</div>';
      }
      html += body.entries.map(saEntryHtml).join('');
    }
    // 底部：能做什么**由类型和状态决定**，不写死。三条失败理由都由服务端翻成人话
    // （见 lib/index.js 的 SUBAGENT_FAILURES），页面只负责把它们显示出来。
    html += body.mode === 'continuable' ? saActsHtml(body)
      : '<div class="sa-none">这是一次性子智能体：跑完就结束了，接不了话，'
        + '只能看它跑过什么。</div>';
    docEl.innerHTML = html;
    saBindActs(body);
  }

  function saActsHtml(body) {
    var html = '';
    // 停：只对「正在跑的、可续接的」那一轮有意义。已经停稳的子智能体没有可停的东西。
    if (body.running) {
      html += '<div class="sa-acts"><button class="btn" id="saStop">停止这一轮</button></div>';
    }
    // 继续说话：只有「可续接」才有这一栏。父会话不在线、并发满了，DSH 都会明确拒绝，
    // 那时候服务端把理由翻成人话给回来，这里照原样弹出来。
    html += '<div class="sa-ask">'
      + '<input id="saAskText" type="text" placeholder="跟它说一句…" autocomplete="off"'
      + ' autocapitalize="off" autocorrect="off" spellcheck="false">'
      + '<button class="btn primary" id="saSend">发送</button></div>';
    return html;
  }

  function saBindActs(body) {
    var stop = $('saStop');
    if (stop) stop.addEventListener('click', function () { saStop(body, stop); });
    var send = $('saSend');
    if (send) send.addEventListener('click', function () { saAsk(body, send); });
  }

  function saStop(body, btn) {
    btn.disabled = true;
    api('/mini/api/subagent/stop', {
      method: 'POST',
      body: JSON.stringify({ id: body.id, mode: body.mode }),
    }).then(function () {
      // 递进去不等于停稳（和主会话那条一样）：重读一次，等它的状态自己翻过来。
      toast('已经让它停下这一轮。');
      saOpenDoc(body.id);
    }).catch(function (err) {
      toast(err && err.message || '停不下来。');
      btn.disabled = false;
    });
  }

  function saAsk(body, btn) {
    var input = $('saAskText');
    var text = input ? input.value.trim() : '';
    if (!text) { toast('先说点什么。'); return; }
    btn.disabled = true;
    api('/mini/api/subagent/ask', {
      method: 'POST',
      body: JSON.stringify({ id: body.id, mode: body.mode, text: text }),
    }).then(function () {
      toast('已经递过去了。');
      saOpenDoc(body.id);
    }).catch(function (err) {
      toast(err && err.message || '没送出去。');
      btn.disabled = false;
    });
  }

  $('btnSubagents').addEventListener('click', function () {
    saToList();
    saPanel.classList.add('open');
    saLoad();
  });
  $('subagentsClose').addEventListener('click', function () { saPanel.classList.remove('open'); });

  // ---------------- 插件页面（2026-10-04） ----------------
  // 从设置里点「插件」→ 立刻盖到设置上面（#plugins 的 z-index 比 #settings 高一档）；
  // 关掉它就回到设置，不用退出设置再去找。分层和两条留白见上面 #plugins 那段 CSS。
  var pluginsPanel = $('plugins');
  $('btnPlugins').addEventListener('click', function () {
    pluginsPanel.classList.add('open');
    loadPlugins();
  });
  $('pluginsClose').addEventListener('click', function () { pluginsPanel.classList.remove('open'); });
  // 点浮层空白处也关掉（和子智能体面板同一套）。
  pluginsPanel.addEventListener('click', function (e) {
    if (e.target === pluginsPanel) pluginsPanel.classList.remove('open');
  });

  function loadPlugins() {
    var listEl = $('pluginsList');
    listEl.innerHTML = pluginNote('正在读取插件列表…');
    api('/mini/api/plugins').then(function (r) {
      listEl.innerHTML = renderPlugins(r || {});
    }).catch(function (err) {
      listEl.innerHTML = pluginNote('读不到插件列表：' + escapeHtml(err.message || '出错了'), true);
    });
  }

  /**
   * 三块，和 PC 的「插件」页 + 「内置插件」页对齐：
   *
   *   官方          —— 能装还没装的（npm 包那一层）
   *   已安装 · 内置 —— **Cordis Loader 的实时条目表**，分「全局插件」和「会话插件」。
   *                    这才是 DSH 的本体粒度：一整套系统是几百个插件模块拼起来的。
   *                    （2026-10-04 用户指出：内置插件拿 npm 包充数是不对的，那只有几个。）
   *   已安装 · 第三方 —— 用户自己装的包。DSH 自家的包不在这里列——它们在上面
   *                    以「模块」的身份出现，那才是「一切皆插件」该有的样子。
   */
  function renderPlugins(r) {
    var bundles = r.bundles || [];
    var official = bundles.filter(function (b) { return b.optional && !b.installed; });
    var third = bundles.filter(function (b) {
      return b.installed && b.name.indexOf('@deepseek-ai/') !== 0;
    });
    var entries = r.entries || [];
    var presets = r.presets || [];
    var sessionRows = 0;
    presets.forEach(function (p) { sessionRows += (p.rows || []).length; });

    var html = '';
    if (r.bundlesError) html += pluginNote('包清单读不到：' + escapeHtml(r.bundlesError), true);
    if (r.officialError) html += pluginNote('官方卡片读不到：' + escapeHtml(r.officialError), true);
    // 官方那一栏是两样拼的（PC 也是这个次序）：可开关的官方包在前，
    // 注册了设置卡片的官方插件（终端 / Agent 循环 / 子智能体 / 网页搜索）在后。
    html += pluginGroup('官方', official.concat(r.official || []), officialRow);

    if (r.builtinError) {
      html += pluginNote('内置插件读不到：' + escapeHtml(r.builtinError), true);
    } else {
      // 内置这一层自己也是一个可折的分组，里面再套「全局插件」「会话插件」两层。
      var inner = '';
      if (entries.length) inner += pluginGroup('全局插件', entries, invRow, 2);
      if (sessionRows) {
        // 这一层的数目是**四个预设各自行数之和**：同一个插件被好几个预设都带上，
        // 所以会重复计（实测共 95 行、其实只有 32 个不重复的插件）。
        // 这里**不再拿括号去解释**（2026-10-05 用户要那句去掉）——下面每个预设
        // 各报各的数（29/30/6/30），加起来就是这个数，顺着看下去就能对上。
        var sessionInner = '';
        presets.forEach(function (p) {
          var rows = p.rows || [];
          if (!rows.length) return;
          if (p.broken) sessionInner += pluginNote('这个预设的组合读不出来：' + escapeHtml(p.broken), true);
          var body = rows.map(invRow).join('');
          // 只有一个预设就不必再套一层；多预设才把预设名露出来（PC 那边是个下拉）。
          // 「（默认）」照 PC 标上：它说的是「不指定模式时按它来」，用户得有这个参照。
          sessionInner += presets.length > 1
            ? pluginFold(p.name + (p.isDefault ? '（默认）' : ''), rows.length, body, 2)
            : body;
        });
        inner += pluginFold('会话插件', sessionRows, sessionInner, 2);
      }
      html += inner
        ? pluginFold('已安装 · 内置', entries.length + sessionRows, inner, 1)
        : pluginNote('这台电脑没报出内置插件。');
    }

    html += pluginGroup('已安装 · 第三方', third, bundleRow);
    if (!html) html = pluginNote('没有插件。');
    return html;
  }

  function pluginNote(text, isErr) {
    return '<div class="' + (isErr ? 'plugin-note' : 'sa-none sa-none-indent') + '">' + text + '</div>';
  }

  /**
   * 一层**可折叠**的分组。默认收起——HTML 里不写 open 属性就自然是收着的，
   * 「默认折叠」不需要额外的代码去保证。没有正文的空层整个不画（点开是个空壳没意义）。
   *
   * `depth` 只影响字号轻重（1 = 官方 / 已安装那一级，2 = 里面那两级）。
   * `note` 是接在计数后面的小注（比如「32 个不重复，4 个预设各算各的」）。
   */
  function pluginFold(title, count, bodyHtml, depth, note) {
    if (!bodyHtml) return '';
    return '<details class="plugin-fold depth-' + (depth || 1) + '"><summary>'
      + escapeHtml(title) + ' ' + count + (note ? '（' + escapeHtml(note) + '）' : '')
      + '</summary>' + bodyHtml + '</details>';
  }

  /** 一堆插件：可折的一层。空的那堆整个不画（不占地方、也不说假话）。 */
  function pluginGroup(title, rows, rowFn, depth) {
    if (!rows.length) return '';
    return pluginFold(title, rows.length, rows.map(rowFn).join(''), depth);
  }

  function rowHtml(name, desc, badge, descCls) {
    return '<div class="plugin-row">'
      + '<div class="plugin-info">'
      + '<span class="plugin-name">' + escapeHtml(name) + '</span>'
      + (desc ? '<span class="plugin-desc' + (descCls || '') + '">' + escapeHtml(desc) + '</span>' : '')
      + '</div>'
      + (badge ? '<span class="plugin-badge ' + badge[0] + '">' + escapeHtml(badge[1]) + '</span>' : '')
      + '</div>';
  }

  /**
   * 一行「包」（官方 / 第三方）。显示名用服务端给的 `title`（本地化标题），
   * 没有就是包名——官方插件在 PC 上显示的正是「智能体团队」这类中文名。
   */
  function bundleRow(b) {
    var desc = b.description || '';
    if (b.problem) desc = desc ? desc + ' · ' + b.problem : b.problem;
    return rowHtml(b.title || b.name, desc,
      [b.enabled ? 'on' : 'off', b.enabled ? '已启用' : '已停用'],
      b.problem ? ' plugin-problem' : '');
  }

  /**
   * 官方那一栏的一行：两种东西都在这里。
   *   · 包（bundles）——带启用状态，能开关；
   *   · 设置卡片（cards）——不是开关，是一张设置页，所以没有状态徽标（PC 上也是这样）。
   */
  function officialRow(item) {
    if (item.kind === 'card') return rowHtml(item.title, item.description || '', null);
    return bundleRow(item);
  }

  /**
   * 一行「内置插件」（Loader 条目 / 预设组合行）。`title` 是服务端压好的短名
   * （`@deepseek-ai/dsh-tool-fs` → `tool-fs`），照 PC 的内置插件面板。
   */
  function invRow(e) {
    return rowHtml(e.title || e.moduleName, e.description || '', invBadge(e));
  }

  /** 运行时状态。**问不到就不编**——预设没挂载时那一行本来就没有运行状态。 */
  function invBadge(e) {
    if (e.phase === 'failed') return ['err', '失败'];
    if (e.conditional) return ['off', '按条件'];
    if (!e.enabled) return ['off', '已停用'];
    if (e.phase === 'active') return ['on', '运行中'];
    if (e.phase === 'loading' || e.phase === 'pending') return ['off', '加载中'];
    return null;
  }
  $('subagentsBack').addEventListener('click', saToList);
  saPanel.addEventListener('click', function (e) {
    if (e.target === saPanel) saPanel.classList.remove('open');
  });

  // ---------------- 权限档位 ----------------
  //
  // 这是把 PC 端那道授权闸门搬到了手机上：**手机从此能指挥 Agent 把电脑提到
  // 完全权限**。闸门还在（要 token / 密码），但它守的那扇门换了一扇——
  // 拿到手机的人等于拿到了这台电脑的写权限。这是功能本身的代价，不是瑕疵。
  //
  // 所以「完全权限」那一档要点两次。用页面内的两步确认、不用 window.confirm：
  // 那种弹窗在微信这类内嵌浏览器里会被直接屏蔽，而在屏蔽的情况下万一返回
  // 真值就等于确认被跳过了——不安全的方向上不能赌。
  //
  // 档位名和标签都是**服务端读出来再给过来的**：有哪些档位、什么顺序、哪个要
  // 确认，这一侧一个都不写死。服务端那边负责把标识符（read-only 这类 DSH 自己的
  // 键名）翻成中文——服务给的 optionOf() 只回键名，三个中文是 DSH 网页界面里的
  // 客户端翻译，服务里没有，所以那张表放在 lib/permissions.js。
  // 映射不到时会退回标识符本身，所以这里拿到的一定是个真名字，不会是空格。
  // 页面只管显示拿到的东西。
  var permOptions = null;   // null = 还没读到（或这台电脑没这个能力）
  var permFor = null;       // 手上这一份 currentValue 是**哪个会话**的
  var permArmed = '';       // 哪一档正在等「再点一次」

  /**
   * 读一次档位盘。
   *
   * **这是个要反复读的动作，不是启动时读一次就够。** 三个理由：
   *   · 答案会变——电脑端随时能改档位，而这一块的作用就是「标出现在是哪一档」；
   *   · 一次读不到就会永远缺这一块——宿主刚重启、绑定会话还没装进 `ctx.agents`
   *     那段时间里，服务端如实回 `no-session`（见 lib/permissions.js 的 listPresets）。
   *     启动时那一次正好撞上，不重读就再也回不来，只有整页刷新能让它出现。
   *     所以设置抽屉每次打开都重读（见上面「设置」那一段）；
   *   · **`currentValue` 是每个会话各一份的**（宿主的 `permission/preset` 记在会话自己
   *     的日志里，`service.current(session)` 读的是这个会话那份投影）。换了会话就不能
   *     拿上一个会话那一档接着显示——那是在说一个假话。所以换会话也要重读
   *     （见 applySnapshot 里换会话那一段）。
   *
   * 传参就是「按这个会话读」；不传是「还是这个会话，重读一次」。
   *
   * 读不到时**只在这块本来就空着的情况下才藏起来**：已经画出来的档位不许因为一次
   * 读失败当场消失——那是把「此刻读不到」错当成「这台电脑没有这个能力」。
   * 换了会话则相反：那一份高亮**必须**当场撤掉，因为它不是这个会话的值。
   * 档位列表本身留着不动——那是宿主的本子，所有会话共用一份。
   */
  function loadPermissions(forSession) {
    var session = forSession === undefined ? permFor : (forSession || null);
    if (session !== permFor) {
      permFor = session;
      permArmed = '';   // 「再点一次」那半次确认也是上一个会话的，不跟着走
      if (permOptions) {
        permOptions.currentValue = '';
        renderPerms();
      }
    }
    api('/mini/api/permissions').then(function (body) {
      // 请求飞在路上时用户又切走了：这一份属于上一个会话，扔掉。
      if (session !== permFor) return;
      if (!body || !body.ok) {
        if (!permOptions) $('permBlock').hidden = true;
        return;
      }
      permOptions = body;
      renderPerms();
    }).catch(function () {
      if (session !== permFor) return;
      // 附加能力缺了不该影响发指令：一个档位都没读到过时，整块不显示。
      if (!permOptions) $('permBlock').hidden = true;
    });
  }

  function renderPerms() {
    if (!permOptions) return;
    $('permBlock').hidden = false;
    var seg = $('segPerm');
    seg.innerHTML = (permOptions.options || []).map(function (o) {
      var cls = [];
      if (o.value === permOptions.currentValue) cls.push('active');
      if (o.value === permArmed) cls.push('armed');
      return '<button type="button" data-perm="' + escapeHtml(o.value) + '"'
        + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>'
        + escapeHtml(o.value === permArmed ? '再点一次：' + o.name : o.name)
        + '</button>';
    }).join('');
    $('permHint').textContent = permHintText();
  }

  /**
   * 提示语。
   *
   * 服务没给说明文字时**不硬编一句**——本机三个档位的 description 全是空的。
   * 那就在这一行显示出当前档位的名字（这个名字是真的，来自服务端），
   * 而不是编一段「Agent 只能读」这种我没法保证准确的话。
   * 「现在在哪一档」主要由按钮的高亮表示，这一行只是补充。
   */
  function permHintText() {
    if (!permOptions) return '';
    var cur = (permOptions.options || []).filter(function (o) {
      return o.value === permOptions.currentValue;
    })[0];
    if (!cur) return '作用在当前会话上';
    return cur.description || ('当前：' + cur.name);
  }

  function tapPerm(name) {
    if (!permOptions) return;
    // 点的就是当前这一档：什么都不做。不这么做的话，一次误触会往会话日志里
    // 记一条没有意义的切换。
    if (name === permOptions.currentValue) return;
    var opt = (permOptions.options || []).filter(function (o) { return o.value === name; })[0];
    if (!opt) return;

    if (opt.dangerous && permArmed !== name) {
      permArmed = name;
      renderPerms();
      toast('再点一次「' + opt.name + '」就切过去');
      return;
    }
    permArmed = '';
    api('/mini/api/permissions', { method: 'POST', body: JSON.stringify({ name: name }) })
      .then(function (body) {
        if (!body || !body.ok) return;
        // 服务端把切换后的最新状态一起回来了，直接重画，不用再补一趟。
        permOptions = body;
        renderPerms();
        toast('已切到「' + opt.name + '」');
      })
      .catch(function (err) {
        permArmed = '';
        renderPerms();
        toast(err.message);
      });
  }

  loadPermissions(state.boundSessionId);

  // 档位按钮的点击。
  //
  // 监听挂在**容器**上，不挂在按钮上——`renderPerms()` 每次都整块换 innerHTML，
  // 挂按钮上的监听会被下一次重画冲掉。挂在容器上就不受影响。
  //
  // 这个坑真机踩到过：三档看得见、点下去毫无反应，因为 `tapPerm` 一次都没被调用。
  // 单元测试没抓住它，是因为测试直接调 `tapPerm` 验逻辑，而真机上缺的是**接线**——
  // 逻辑对、没人喊它。
  $('segPerm').addEventListener('click', function (e) {
    var btn = e.target;
    // 按钮里现在只有文字，点到的就是按钮本身；这个循环是防将来往里塞图标。
    while (btn && btn !== this && !(btn.dataset && btn.dataset.perm)) btn = btn.parentNode;
    if (!btn || btn === this) return;
    tapPerm(btn.dataset.perm);
  });

  Array.prototype.forEach.call($('segMode').children, function (btn) {
    btn.addEventListener('click', function () {
      state.mode = btn.dataset.mode;
      $('hintMode').textContent = modeHint();
      localStorage.setItem('dshMiniMode', state.mode);
      syncSeg();
      render();
      // 切到「完整」：订上并把已有的过程拉下来；切走：退订、停推。
      syncTrajectorySubscription();
      // 离开「单帧」时正文流式才成立：连接是在单帧里建的就没带 stream=1，这里补一次重连。
      syncStreamSubscription();
    });
  });
  Array.prototype.forEach.call($('segSound').children, function (btn) {
    btn.addEventListener('click', function () {
      state.sound = btn.dataset.sound === 'on';
      localStorage.setItem('dshMiniSound', state.sound ? 'on' : 'off');
      if (state.sound) unlockAudio();
      syncSeg();
    });
  });

  // 鲸鱼娘（立绘）开关。默认关，口径见 state.pet。
  // 打开的那一刻才建层、预热（preloadPoses 幂等）——关着的人不该为这九张图付流量。
  // 关掉只是让 render() 给 #work 挂 bare 藏装饰；计时和「停止」照旧，任务能中止。
  Array.prototype.forEach.call($('segPet').children, function (btn) {
    btn.addEventListener('click', function () {
      if (state.mode === 'full') return;   // 完整模式不画装饰，按钮是灰的
      state.pet = btn.dataset.pet === 'on';
      localStorage.setItem('dshMiniPet', state.pet ? 'on' : 'off');
      if (state.pet) preloadPoses();
      syncSeg();
      render();
    });
  });

  // ---------------- 外观（深色 / 浅色 / 跟随系统） ----------------
  // 只改 <html> 上的 data-theme，样式表里两套令牌各管各的。这里不碰任何具体颜色，
  // 免得以后加第三套主题还要回来改这一段。
  // 首屏那次由 <head> 里那一小段负责（不然会闪）；这一段管切换和"跟着系统变"。
  function resolvedTheme() {
    if (state.theme !== 'auto') return state.theme;
    var dark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? 'dark' : 'light';
  }
  function applyTheme() {
    var use = resolvedTheme() === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', use);
    // 手机状态栏那块颜色也跟着走，否则浅色页配一条深色状态栏，像没画完。
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', use === 'light' ? '#eaf3fc' : '#0a0f16');
  }
  // ---------------- 流式输出（开 / 关） ----------------
  //
  // 关着时和以前一模一样（等整段落定）；开着时正文一个字一个字冒出来（见 trajectory-live
  // 那一段的 `kind: 'text'` 分支）。
  //
  // **切完要重连一次**：`stream=1` 是在建立连接时带上的，服务端据此决定这条连接要不要
  // 收正文帧。就地改 state 不够——那条已经连着的流不知道你要改了。
  Array.prototype.forEach.call($('segStreaming').children, function (btn) {
    btn.addEventListener('click', function () {
      if (state.mode === 'minimal') return;   // 单帧不跟，按钮是灰的
      var want = btn.dataset.streaming === 'on';
      if (want !== state.streaming) {
        state.streaming = want;
        localStorage.setItem('dshMiniStreaming', want ? 'on' : 'off');
        // 关掉时把屏幕上可能残留的流式影子撤掉，不然会停在半句话上直到下一条消息。
        if (!want) state.live = '';
        syncSeg();
        render();
      }
      // **值没变也要对一次订阅**（2026-10-22）：开关本来就存着「开」，但连接是在
      // 单帧里建的、没带 stream=1——点一下等于「重连一次」，不然它会一直显示「开」
      // 却一个正文帧都收不到。已经对上了就什么都不做。
      syncStreamSubscription();
    });
  });

  Array.prototype.forEach.call($('segTheme').children, function (btn) {
    btn.addEventListener('click', function () {
      state.theme = btn.dataset.theme;
      localStorage.setItem('dshMiniTheme', state.theme);
      applyTheme();
      syncSeg();
    });
  });
  if (window.matchMedia) {
    var themeMq = window.matchMedia('(prefers-color-scheme: dark)');
    var onThemeMq = function () { if (state.theme === 'auto') applyTheme(); };
    if (themeMq.addEventListener) themeMq.addEventListener('change', onThemeMq);
    else if (themeMq.addListener) themeMq.addListener(onThemeMq);
  }
  applyTheme();   // 补上首屏那次没做的一件事：把状态栏颜色对齐

  // ---------------- 字体大小（小 / 标准 / 大） ----------------
  // 2026-11-27：三档一起往下收一档（15.5 → 15、13 → 12.5），大档不动。
  // 理由见 :root 的说明——同屏多了过程清单和指令行，密度该跟上；再小就不好读了。
  function applyFontSize() {
    var sizes = { small: '12.5px', normal: '15px', large: '18px' };
    document.documentElement.style.setProperty('--font-base', sizes[state.fontSize] || sizes.normal);
  }
  Array.prototype.forEach.call($('segFont').children, function (btn) {
    btn.addEventListener('click', function () {
      state.fontSize = btn.dataset.font;
      localStorage.setItem('dshMiniFont', state.fontSize);
      applyFontSize();
      syncSeg();
    });
  });
  applyFontSize();  // 首屏应用

  // 过程清单的展开状态要跨重绘记住（原生 <details> 重画一次就回默认折叠）。
  // 绑在顶层而不是 bindTraj 里：`toggle` 不冒泡，捕获阶段收得到；而且 bindTraj
  // 被 page.test.mjs 的切片单独抠出来跑，里面有切片外的引用就是一发 ReferenceError。
  replyEl.addEventListener('toggle', onProcessToggle, true);

  function syncSeg() {
    Array.prototype.forEach.call($('segMode').children, function (b) {
      b.classList.toggle('active', b.dataset.mode === state.mode);
    });
    Array.prototype.forEach.call($('segStreaming').children, function (b) {
      b.classList.toggle('active', (b.dataset.streaming === 'on') === state.streaming);
      // 单帧模式不跟流式（用户 2026-10-21 拍板）：那一屏只看最终那一句，
      // 开关在这里灰掉，但**不改存的值**——切回聊天/完整它还是你上次的选择。
      b.disabled = state.mode === 'minimal';
    });
    Array.prototype.forEach.call($('segSound').children, function (b) {
      b.classList.toggle('active', (b.dataset.sound === 'on') === state.sound);
    });
    Array.prototype.forEach.call($('segTheme').children, function (b) {
      b.classList.toggle('active', b.dataset.theme === state.theme);
    });
    Array.prototype.forEach.call($('segFont').children, function (b) {
      b.classList.toggle('active', b.dataset.font === state.fontSize);
    });
    Array.prototype.forEach.call($('segPet').children, function (b) {
      b.classList.toggle('active', (b.dataset.pet === 'on') === state.pet);
      // 「完整」模式本来就不画装饰（那一屏由轨迹自己逐条冒），这一档在那儿点了也看不见
      // 变化——灰掉，但**不改存的值**：切回聊天/单帧它还是你上次的选择。
      b.disabled = state.mode === 'full';
    });
  }

  // 会话切换挪到左侧导航栏了（原来这里是设置里的下拉框）。

  // ---------------- 锁屏也能提醒（系统通知） ----------------
  //
  // 页内的响铃和震动只在页面看得见的时候有用。人把手机放下、屏幕锁了，那两样都
  // 叫不醒他——要叫醒他只能发系统通知。
  //
  // 这条路以前是关着的，三层原因叠在一起：
  //   1. 通知权限只能在「安全上下文」（HTTPS 或 localhost）里申请。当时三条连接
  //      路径全是明文 HTTP，浏览器连这个 API 都不给；
  //   2. 就算拿到权限，new Notification() 在大多数移动浏览器上会抛 TypeError，
  //      移动端唯一正确的入口是 service worker 的 showNotification；
  //   3. service worker 同样要求 HTTPS。
  // 2026-09-25 Tailscale 那条路接上 HTTPS，第 1、3 条同时成立，这条路才通。
  //
  // **所以这一行只在加密连接下露出来。** 明文下露出来，用户点一下只会碰一鼻子灰
  // ——那正是 2026-09-21 把它整行撤掉的理由，那条理由现在仍然成立。
  //
  // 电脑端的外部推送（Bark / ntfy / Telegram）是另一条路：从服务器发出去，不经
  // 浏览器，明文连接下也照常能用。两者不冲突，各管一段。
  var NOTIFY_OK = window.isSecureContext
    && 'serviceWorker' in navigator
    && 'Notification' in window;

  function notifySystem(text) {
    if (!state.notify || !NOTIFY_OK) return;
    if (Notification.permission !== 'granted') return;
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.showNotification('回复到了', {
        body: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        // 带上 tag：同一条回复重复到达时替换掉旧的，别堆一屏。
        tag: 'dsh-reply',
        renotify: true,
        // 地址由页面给。不能拿 service worker 自己的 location 拼——那是那个 .js
        // 文件的地址，用户点通知会打开一份源码。
        data: { url: location.href },
      });
    }).catch(function () { /* 发不出去就算了，不该影响主流程 */ });
  }

  function syncNotify() {
    Array.prototype.forEach.call($('segNotify').children, function (b) {
      b.classList.toggle('active', (b.dataset.notify === 'on') === state.notify);
    });
  }

  /**
   * 繁忙时的发送行为（2026-10-05 用户要求搬进手机设置）。
   *
   * 这是 PC「设置 → 通用」里那一条的同款：智能体跑着的时候，你发的话是
   * 排队等这一轮跑完，还是当场插进去让它调整方向。**两端共用宿主那一份设置**，
   * 所以这里改完，电脑上也是这个值——这是用户拍板要的（同一个开关，别两端各存一份）。
   *
   * **读不到就整条不画**：拿不到宿主设置时把那一行藏起来，不摆一个点了没用的开关。
   * 这和插件页「宁可少画，不凭空多画」是同一条口径。
   *
   * 写的时候带上服务端给的 revision（乐观锁）：万一电脑上刚改过，这次写入会被挡下来，
   * 而不是把对方那次改动悄悄盖掉——那种覆盖用户看不见，最难查。
   */
  var busyEnter = { current: 'queue', revision: null, ready: false };
  function paintBusyEnter() {
    Array.prototype.forEach.call($('segBusyEnter').children, function (b) {
      b.classList.toggle('active', b.dataset.busy === busyEnter.current);
    });
  }
  function loadBusyEnter() {
    api('/mini/api/busy-enter').then(function (r) {
      if (!r || !r.ok) {
        // 这台电脑没提供这个设置（老版本 DSH、或设置文档里没这一项）。
        // 藏起来就好，不用报错——那不是「出错」，是「这里本来就没有」。
        $('rowBusyEnter').hidden = true;
        return;
      }
      busyEnter.current = r.current === 'steer' ? 'steer' : 'queue';
      busyEnter.revision = typeof r.revision === 'number' ? r.revision : null;
      busyEnter.ready = true;
      $('rowBusyEnter').hidden = false;
      paintBusyEnter();
    }).catch(function () {
      $('rowBusyEnter').hidden = true;
    });
  }
  $('segBusyEnter').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-busy]') : null;
    if (!btn || !busyEnter.ready) return;
    var next = btn.dataset.busy;
    if (next === busyEnter.current) return;
    // 先画再发：这一下是用户自己按的，立刻有反馈；发失败了再画回去并说清。
    var prev = busyEnter.current;
    busyEnter.current = next;
    paintBusyEnter();
    api('/mini/api/busy-enter', {
      method: 'POST',
      body: JSON.stringify({ value: next }),
    }).then(function (r) {
      if (r && r.ok) {
        toast(r.current === 'steer' ? '繁忙时改为插话发送' : '繁忙时改为排队发送');
        busyEnter.revision = typeof r.revision === 'number' ? r.revision : busyEnter.revision;
        return;
      }
      // 失败要画回去——留着那个没生效的选中态，用户会以为改成功了。
      busyEnter.current = prev;
      paintBusyEnter();
      toast(r && r.reason === 'unavailable' ? '这台电脑改不了这一项' : '没能改成，再试一次');
    }).catch(function () {
      busyEnter.current = prev;
      paintBusyEnter();
      toast('没能改成，检查一下连接');
    });
  });

  /**
   * 「进阶设置（电脑端界面）」（2026-10-06 用户要求）。
   *
   * 手机上这张遥控页是**专门为手机做的**，所以电脑上那些插件贡献的设置页它进不去。
   * 这一项是退路：**把电脑端的界面整个搬过来看**——同一份界面，不迁移、不逐个适配。
   * 服务端怎么把这个界面转出来的，写在 lib/mirror.js 开头。
   *
   * **它是个权限开关，不是普通偏好。** 打开它 = 这个令牌的权限从「我们这张手机页
   * 暴露的那点事」扩到整个电脑端设置面（模型配置、凭据页、插件装卸、会话记录……）。
   * 所以三件事一个都不能省：
   *   ① 默认关；
   *   ② 后果写在提示里，而且要等**第二次点击**才真开（`armed`）——照「完全权限」
   *      那一档的规矩，理由也一样（页内两步，不用 window.confirm：那种弹窗在微信
   *      这类内嵌浏览器里会被直接屏蔽，屏蔽时万一返回真值就等于确认被跳过）；
   *   ③ 关着的时候**入口那一行也不显示**——不是露一个点了没用的按钮。
   *
   * 读不到就整块不画：这台电脑没这个能力时（没拿到 DSH_WEB_URL），
   * 藏起来就好，不摆一个假开关。
   */
  var mirror = { available: false, enabled: false, armed: false, ready: false };

  function paintMirror() {
    $('rowMirror').hidden = !mirror.available;
    if (!mirror.available) {
      $('rowMirrorOpen').hidden = true;
      return;
    }
    Array.prototype.forEach.call($('segMirror').children, function (b) {
      b.classList.toggle('active', (b.dataset.mirror === 'on') === mirror.enabled);
    });
    $('mirrorHint').textContent = mirror.enabled
      ? '已打开。手机现在能进整个电脑设置面'
      : mirror.armed
        ? '打开的后果：手机将获得完整的电脑设置权限。再点一次「开」确认'
        : '打开电脑上的 DSH 界面，改那些手机上没有的设置';
    $('rowMirrorOpen').hidden = !mirror.enabled;
  }

  /**
   * 镜像入口那个地址。
   *
   * **尾斜杠不能省**：那个界面外壳写着 `<base href="./">`，在 `/mini/mirror` 上它
   * 解析成 `/mini/`，在 `/mini/mirror/` 上才是 `/mini/mirror/`——差这一个字符，
   * 里面引用的脚本会全 404、界面白屏（真浏览器验出来的）。
   *
   *
   * **地址里不带令牌**（2026-10-16 第二步）：这个框是同源文档，设备 cookie 会自动跟着
   * 它的每一条请求走（文档本身、静态资源、界面自己发的 `/api/*`），入口那一下不再需要
   * 顺手写 cookie。上游收到的东西里一个字节的凭据都没有——第一步已经钉住。
   */
  function mirrorUrl() {
    return '/mini/mirror/';
  }

  /**
   * 点「打开」：把那一整屏显示出来，并**在那一刻**才给框设地址（没点之前不加载）。
   *
   * 这一版为什么能成：**没有跳转、没有新标签、没有弹窗**——浏览器没有任何东西可以拦。
   * 前两版都在赌「跳转」这个动作（详见页面里 `#mirrorView` 上面那段注释）。
   */
  function openMirror() {
    if (!mirror.enabled) return;
    // **先给一句提示，再显示那一屏。**
    //
    // 这一句不是装饰，是**诊断**（2026-10-06 用户三次报「点了没反应」之后加的）：
    // 三种情况从此分得开——看到提示且界面出来＝成了；只看到提示＝显示那一步的问题；
    // 连提示都没有＝点击压根没到按钮上。前三次就是分不开这三种，才一路猜错。
    toast('正在打开电脑端界面…');
    // **顺序要紧：先把这一层显示出来，再给框设地址。**
    //
    // 反过来的话，那个界面是**在 `display:none` 里开始加载的**——在不可见的上下文里
    // 渲染出来的东西，要等用户点一下触发重绘才画全（真机上就是「图标旁边的文字
    // 点一下才出来」）。2026-10-06 查出：**直接打开镜像没有这个毛病**，
    // 差别就在这两行的先后。
    $('mirrorView').hidden = false;
    $('mirrorFrame').src = mirrorUrl();
  }

  function closeMirror() {
    $('mirrorView').hidden = true;
    // 收起状态一起复位：下次进来从「看不见」开始（鼠标若正好停在顶上，
    // 那一下 mousemove 会把它勾出来，见下面的接线）。
    mirrorBarOff();
    // 把地址清掉：那一屏里是个完整应用（还在跑、还连着），关掉就该真停，
    // 而不是留在后台继续占内存和连接。
    $('mirrorFrame').src = 'about:blank';
  }

  // 按钮和**整行**都绑：那个按钮只有 54×40，手指容易点偏；整行点下去都算数。
  $('btnMirrorOpen').addEventListener('click', openMirror);
  $('rowMirrorOpen').addEventListener('click', function (e) {
    // 点在按钮上时上面那个监听已经处理了，别处理两遍。
    if (e.target === $('btnMirrorOpen')) return;
    openMirror();
  });
  $('mirrorClose').addEventListener('click', closeMirror);

  /**
   * 顶栏的「收 / 放」（2026-10-15 用户要的甲案：鼠标移到屏幕顶部才滑出来）。
   *
   * 为什么非要有那条 16px 感应带、为什么手机不走这一套：样式表里那一段说清了。
   * 这里只说两件必须做对的事：
   *
   * ① **贴到顶上先停 0.18 秒再滑出**。鼠标路过顶边去点官方界面时（右上角那个
   *    「打开右侧边栏」就在第 28px），不该把它勾出来；停这么一下就不会误触发。
   *
   * ② **「返回」永远可达**——它是唯一回手机页的出口，绝不能藏死：
   *    · 鼠标碰到顶上 16px 就出来（滑出只是一次 0.18 秒的等待）；光标停在感应带上
   *      不动也没关系：显示之后感应带还在最上面，鼠标一动就再勾一次；
   *    · 键盘 Tab 停在「返回」上时也把它亮出来（下面 focus 那一条），
   *      不留一个「焦点在这、按钮看不见」的坑；
   *    · 滑出时横条**占自己的位置**、不盖在官方界面上，谁也挡不住它；
   *    · 手机上它压根不藏（触摸没有悬停，藏了就等于摸不到）。
   */
  var mirrorHot = $('mirrorHot');
  var mirrorBar = $('mirrorBar');
  var barShowTimer = null;
  var barHideTimer = null;

  function mirrorBarOn() { $('mirrorView').classList.toggle('bar-on', true); }
  function mirrorBarOff() { $('mirrorView').classList.toggle('bar-on', false); }

  if (mirrorHot && mirrorBar && mirrorHot.addEventListener) {
    function barScheduleShow() {
      if (barShowTimer) return;
      clearTimeout(barHideTimer);
      barShowTimer = setTimeout(function () { barShowTimer = null; mirrorBarOn(); }, 180);
    }
    // 收的时候也先等 0.2 秒：鼠标可能是从感应带往下挪进横条里（那条就贴在它下面），
    // 中途路过那一下不该被判成「离开了」。
    function barScheduleHide() {
      clearTimeout(barShowTimer);
      barShowTimer = null;
      clearTimeout(barHideTimer);
      barHideTimer = setTimeout(mirrorBarOff, 200);
    }
    // **桌面与触摸走两套事件**（2026-10-18）：桌面有悬停，鼠标贴到顶上滑出、移开收回；
    // 触摸没有悬停这回事，改成"点一下切换"——点顶部那条把手拉出来，再点一下收回去。
    // 判定用媒体查询，和样式表里同一套条件（`hover:hover and pointer:fine` = 有鼠标）。
    var barHasHover = !!(window.matchMedia
      && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    if (barHasHover) {
      mirrorHot.addEventListener('mouseenter', barScheduleShow);
      // 显示这一屏那一刻鼠标可能就停在顶上（那时不会再有 mouseenter）——动一下也算数。
      mirrorHot.addEventListener('mousemove', barScheduleShow);
      mirrorHot.addEventListener('mouseleave', barScheduleHide);
      mirrorBar.addEventListener('mouseenter', function () { clearTimeout(barHideTimer); });
      mirrorBar.addEventListener('mouseleave', barScheduleHide);
    } else {
      // 触摸：按住拖动不算（不在 iframe 里），只有"点"才切换。
      mirrorHot.addEventListener('click', function () {
        if ($('mirrorView').classList.contains('bar-on')) mirrorBarOff();
        else mirrorBarOn();
      });
    }
  }
  // Tab 走到「返回」上要看得见它。
  $('mirrorClose').addEventListener('focus', mirrorBarOn);

  /**
   * 框里那一页自己发的「返回手机页」。
   *
   * **为什么需要**：镜像那一屏里，框中的文档正常情况下是电脑端界面（它有自己的退出方式），
   * 但**打不开的时候**它是我们自己发的一页提示（见 lib/server.js 的 sendMirrorUnavailable）
   * ——那一页里除了浏览器自己的返回，没有别的出口，用户会卡在一个提示页上。
   * 所以那一页的「返回」按钮往这里发一条消息，我们把这整屏收起来。
   *
   * 只认这一条字符串，且只认同源：这个监听**只做「收屏」这一件事**，别的消息一概不理。
   */
  window.addEventListener('message', function (e) {
    if (e.origin === location.origin && e.data === 'mini-mirror-close') closeMirror();
  });

  function loadMirror() {
    api('/mini/api/mirror').then(function (r) {
      if (!r || !r.ok || !r.available) {
        mirror.available = false;
        paintMirror();
        return;
      }
      mirror.available = true;
      mirror.enabled = r.enabled === true;
      mirror.ready = true;
      paintMirror();
    }).catch(function () {
      mirror.available = false;
      mirror.armed = false;
      paintMirror();
    });
  }

  function tapMirror(next) {
    if (!mirror.ready) return;
    if (next === 'off') {
      // 关掉不需要确认：往「更安全」的方向走，不用拦。
      mirror.armed = false;
      if (!mirror.enabled) { paintMirror(); return; }
      mirror.enabled = false;
      paintMirror();
      api('/mini/api/mirror', { method: 'POST', body: JSON.stringify({ enabled: false }) })
        .then(function (r) {
          if (r && r.ok) { toast('已关掉电脑端界面'); return; }
          mirror.enabled = true;
          paintMirror();
          toast('没能关掉，再试一次');
        })
        .catch(function () {
          mirror.enabled = true;
          paintMirror();
          toast('没能关掉，检查一下连接');
        });
      return;
    }
    // 开：第一次点只是「举起来」，把后果摆出来；再点一次才真开。
    if (!mirror.enabled && !mirror.armed) {
      mirror.armed = true;
      paintMirror();
      return;
    }
    if (mirror.enabled) return;
    mirror.armed = false;
    mirror.enabled = true;
    paintMirror();
    api('/mini/api/mirror', { method: 'POST', body: JSON.stringify({ enabled: true }) })
      .then(function (r) {
        if (r && r.ok) { toast('已打开，点下面的「打开」进去'); return; }
        mirror.enabled = false;
        paintMirror();
        toast(r && r.reason === 'unavailable' ? '这台电脑没有这个能力' : '没能打开，再试一次');
      })
      .catch(function () {
        mirror.enabled = false;
        paintMirror();
        toast('没能打开，检查一下连接');
      });
  }

  $('segMirror').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-mirror]') : null;
    if (!btn) return;
    tapMirror(btn.dataset.mirror);
  });

  if (NOTIFY_OK) {
    // 先注册 service worker。**这一步不申请权限**——权限要用户主动点一下才给，
    // 页面一加载就弹窗会被浏览器直接拒掉，而且很讨厌。
    //
    // 注册成功才把那一行露出来。注册不上就继续藏着：露一个点了没用的开关，
    // 比没有更让人困惑。
    //
    // **2026-09-25 用户裁决：这一行不露出来了。**
    //
    // 试到底了：手机锁屏后系统冻结后台页面，那条实时连接跟着断掉，回复根本到不了页面，
    // 也就没人去发通知。这是手机系统的调度，插件绕不过去；service worker 也救不了——
    // 它是被事件唤醒的，没有事件它就不存在。
    //
    // 用户原话：「类似功能我们以后考虑做成 APP 时再加，浏览器里不放了。」
    //
    // **代码全部留着，只是不露出来。** service worker 照常注册（已经验证过在加密连接下
    // 能正常工作），通知那段逻辑照常挂在回复到达的分支里。将来做 App 里的锁屏提醒，
    // 这里的知识直接能用。
    //
    // 要重新打开：把下面两行取消注释。**但先把名字想清楚**——别再用「锁屏也能提醒」
    // 这种它做不到的说法，那是这一轮踩过的坑。
    navigator.serviceWorker.register('/mini/sw.js?v=' + BUILD).catch(function () {});
    // $('rowNotify').style.display = '';
    // $('notifyHint').textContent = notifyHintText();
    // syncNotify();

    // 浏览器现在给的是什么状态，就说什么话。
    //
    // **不能只说「打开时会问一次」**——2026-09-25 用户点了「开」，浏览器什么都没问，
    // 界面上也一点变化都没有，看上去就是「点了没用」。真实原因是这个网站的通知权限
    // 早就被拒过，而 requestPermission() 在这种情况下**不会再弹**，直接回 denied。
    // 所以每一种状态都得有对应的一句话，用户才能自己判断下一步该干什么。
    function notifyHintText() {
      var p = Notification.permission;
      if (p === 'granted') return '回复到了发一条系统通知';
      if (p === 'denied') return '权限被拒过，浏览器不会再问。去浏览器设置里允许，或清掉本站数据后重新扫码';
      return '打开时浏览器会问一次要不要允许';
    }

    // 申请通知权限。**两种写法都要兼容**：新浏览器返回 Promise，老一点的和一些厂商
    // 定制内核只认回调式——直接 .then() 会抛，表现同样是「点了没反应」。
    // 回调式在所有支持这个 API 的浏览器上都会被调用（包括那些同时支持 Promise 的），
    // 所以以它为主，Promise 只当兜底。
    function askNotifyPermission() {
      var settled = false;
      function settle(perm) {
        if (settled) return;
        settled = true;
        if (perm !== 'granted') {
          $('notifyHint').textContent = '浏览器没给通知权限（现在是「' + (perm || '没反应')
            + '」）。去浏览器设置里允许，或清掉本站数据后重新扫码。';
          syncNotify();
          return;
        }
        state.notify = true;
        localStorage.setItem('dshMiniNotify', 'on');
        $('notifyHint').textContent = notifyHintText();
        syncNotify();
      }
      try {
        var r = Notification.requestPermission(settle);
        if (r && typeof r.then === 'function') r.then(settle).catch(function () {});
      } catch (err) {
        $('notifyHint').textContent = '这个浏览器问不出通知权限。要去浏览器的设置里手动开。';
        return;
      }
      // 有些内核两条路都不回来。等三秒给个交代，别让用户对着一个没反应的开关发呆。
      setTimeout(function () {
        if (!settled) {
          $('notifyHint').textContent = '浏览器没弹权限询问（现在是「' + Notification.permission
            + '」）。去浏览器设置里允许，或清掉本站数据后重新扫码。';
        }
      }, 3000);
    }

    $('segNotify').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.notify !== 'on') {
        state.notify = false;
        localStorage.setItem('dshMiniNotify', 'off');
        syncNotify();
        return;
      }
      // 已经允许过了就别再问——问了也不会弹，只会让用户以为坏了。
      if (Notification.permission === 'granted') {
        state.notify = true;
        localStorage.setItem('dshMiniNotify', 'on');
        $('notifyHint').textContent = notifyHintText();
        syncNotify();
        return;
      }
      askNotifyPermission();
    });
  }

  $('btnReconnect').addEventListener('click', function () {
    connect();
    toast('正在重连…');
  });

  /**
   * 「重新输入令牌」：把闸门露出来，让用户再贴一枚令牌进来。
   *
   * **这一下不再清除任何东西**（2026-10-16 第二步）：身份已经是一枚 HttpOnly 的设备
   * cookie，页面看不到也删不掉它——真正的「把这台设备赶出去」在电脑那边（名册里删掉
   * 它，下一步做进设置页）。按钮原来叫「清除 token」，那个名字从这一刻起就是假的。
   */
  $('btnForget').addEventListener('click', function () {
    sheet.classList.remove('open');
    showGate();
  });

  // ---------------- token 闸门 ----------------
  function showGate() {
    $('gate').classList.add('open');
    $('gateErr').textContent = '';
    setTimeout(function () { $('gateInput').focus(); }, 120);
  }
  $('gateBtn').addEventListener('click', submitGate);
  $('gateInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitGate();
  });
  /**
   * 把手里这枚令牌交回**门口那一次**（和扫码进来是同一条路）。
   *
   * 为什么不在这里校验一次、把它留在手里：令牌留在手里就等于**撤销失效**——名册里
   * 把这条记录删掉之后，这台设备还会拿令牌进门。所以这里只是**跳一次**：服务端在门口
   * 认这枚令牌、换成设备 cookie（HttpOnly），页面自己一个字节都不记。
   * 令牌不对时服务端会重新发下门禁页；下面启动那一段看地址里那枚 token 就知道要报什么。
   */
  function submitGate() {
    var value = $('gateInput').value.trim();
    if (!value) { $('gateErr').textContent = '请先粘贴 token'; return; }
    $('gateErr').textContent = '校验中…';
    location.replace(location.pathname + '?token=' + encodeURIComponent(value));
  }

  // ---------------- presence 与心跳 ----------------
  document.addEventListener('visibilitychange', function () {
    var hidden = document.hidden;
    if (state.entered) {
      api('/mini/api/presence', {
        method: 'POST',
        body: JSON.stringify({ state: hidden ? 'background' : 'foreground' })
      }).catch(function () {});
    }
    if (!hidden) { render(); connectIfDead(); }
  });
  setInterval(function () {
    if (state.entered) api('/mini/api/heartbeat', { method: 'POST', body: '{}' }).catch(function () {});
  }, 30000);

  function connectIfDead() {
    // 切回前台时 EventSource 可能已经悄悄死了，探一下。
    if (!state.entered) return;
    if (es && es.readyState === EventSource.OPEN) return;
    connect();
  }

  /**
   * 服务器换过代码就自己刷新一次。
   *
   * 为什么非要有：这个页面是**启动时读进内存**才发出去的（改了要重启 DSH），而立绘是
   * **每次请求现读盘**的（文件一改就生效）。于是"页面和图不是同一时刻换的"这件事真的
   * 会发生——2026-09-29 用户在手机上看到「原来的两条腿变成 4 条腿了」：手里那份页面还是
   * 旧的（写死按两格、244 像素宽去切），硬盘上的图已经是六格的了，122 像素的窗口里于是
   * 挤进三个压扁的小人，看着就是一堆腿。
   *
   * `/mini/api/version` 报的是**服务器现在这份代码**的构建号：和手里这份一样就什么都不做，
   * 不一样说明页面过期了，刷一次就好（刷新后拿到的新页面自带正确的切帧规则）。
   * **正在打字就先不刷**——用户没发出去的话不能被吞掉，等下一轮再说。
   */
  function watchBuild() {
    if (!state.entered) return;
    api('/mini/api/version').then(function (r) {
      // 设置页底部那行版本。**问到才显示**——问不到就整行不出现，
      // 不拿「unknown」糊一行上去（那个字对用户没意义，还像页面坏了）。
      // 产品名写全称（DeepSeek Harness）：缩写 DSH 只有我们自己人认。
      // 大小写照 DSH 自己的界面串（实测 49 处全是这个写法）。
      if (r && r.dshVersion && r.dshVersion !== 'unknown') {
        var el = $('dshVersion');
        if (el) { el.textContent = 'DeepSeek Harness ' + r.dshVersion; el.hidden = false; }
      }
      if (!r || !r.build || r.build === BUILD) return;
      if (inputEl.value && inputEl.value.trim()) return;
      location.reload();
    }).catch(function () { /* 读不到就当没这回事，别把页面弄崩 */ });
  }

  // 复制按钮：整篇、单条气泡、代码块共用一套。
  // 用事件委托——回复区每次都是整块重绘的，逐个绑会漏。
  // （原来这里是「点回复区任意位置复制全文」，它直接用了 navigator.clipboard，
  //   在明文 HTTP 下那个接口是 undefined，点了什么都不会发生；而且它会和
  //   新加的按钮打架，所以换成显式按钮。）
  replyEl.addEventListener('click', function (e) {
    // 长指令气泡的「展开 / 收起」：只动这一块，不重画整串历史。
    var more = e.target && e.target.closest ? e.target.closest('.bubble-more') : null;
    if (more) {
      var key = more.getAttribute('data-more') || '';
      var text = more.parentNode && more.parentNode.querySelector
        ? more.parentNode.querySelector('.bubble-text') : null;
      if (!text) return;
      var expanded = more.getAttribute('aria-expanded') !== 'true';
      more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      more.textContent = expanded ? '收起' : '展开';
      text.classList.toggle('clamped', !expanded);
      if (expanded) expandedUserMsgs[key] = true; else delete expandedUserMsgs[key];
      return;
    }
    var btn = e.target && e.target.closest ? e.target.closest('.copy') : null;
    if (!btn) return;
    e.preventDefault();
    copyText(btn.getAttribute('data-copy') || '', btn);
  });

  // main 的滚动：一句提示的露 / 收，和「再放一屏」，都挂在这一根线上（见 onMainScroll）。
  // **这根线不能省**：逻辑写得再对，没挂上去就是「一点反应都没有」，
  // 而这种坏光看代码是看不出来的。
  // 位置也有讲究：绑在这里，不绑在 atBottom 那片函数旁边——页面测试会把那一段
  // 整块抠出来求值，测试里的假 mainEl 没有 addEventListener，写在那边好几个测试当场报错。
  mainEl.addEventListener('scroll', onMainScroll);

  // 「回到底部」浮标（2026-10-08）也挂在这一根滚动线上，但**另起一条监听**：
  // onMainScroll 被页面测试整块抠出来跑（chatPager 那个替身只给了 state / replyEl /
  // mainEl / timeLabel，没有 $），把浮标并进去会让那几个测试当场报 ReferenceError。
  mainEl.addEventListener('scroll', paintToBottom);
  // 首屏先定一次：刚进来是空页，按判据算「在底部」，浮标该是收着的。
  paintToBottom();

  // 点它：**瞬时**到底，不做平滑滚动。
  //
  // 两条理由，都是「跟现成的东西保持一致」而不是我挑的：
  //   · 用户原话就是「瞬间」；
  //   · 电脑端那颗也是瞬时的（ChatView 里 reading.followTail → viewport.scrollToBottom
  //     → follow.toBottom(..., 'instant')）；
  //   · 本页「按发送回底部」本来就是直接赋值（见 send 里那句
  //     mainEl.scrollTop = mainEl.scrollHeight），同一件事用同一套动作，
  //     用户不会看到「有时滑一下、有时直接跳」两种脾气。
  //
  // 赋值本身会发一次 scroll 事件，浮标自己就收了；这里再补一次是防「本来就在最底、
  // 位置没变所以不发事件」那一种——补一下，状态就是确定的。
  $('toBottom').addEventListener('click', function () {
    mainEl.scrollTop = mainEl.scrollHeight;
    paintToBottom();
  });

  // ---------------- 启动 ----------------
  syncSeg();
  autoGrow();
  if (!state.entered) {
    // 服务端没放行：这是一张只用来输入令牌的门禁页。
    // 地址里那枚 token = 刚才手输（或扫码）交上来的那一枚，它没被认下来才会走到这儿——
    // 报一句人话，并把地址栏擦掉（不把输错的令牌留在那儿）。
    var bad = params.get('token');
    if (bad) history.replaceState(null, '', location.pathname);
    showGate();
    if (bad) $('gateErr').textContent = 'token 不正确，请核对后重试';
    // 被撤销的那台设备：**说清发生了什么、下一步做什么**。不说的话，用户看到的
    // 只是一张"要令牌"的页面——他昨天还能用，今天莫名其妙进不去了。
    if (DEVICE_REVOKED) $('gateRevoked').hidden = false;
  } else {
    // 鲸鱼娘关着（默认）就不建层、不预热：九张图约 0.8 MB，没人看的时候不该先下载。
    // 在设置里打开的那一刻补上（见 segPet 的点击）。
    if (state.pet) preloadPoses();
    connect();
  }
  // 任何一次触摸都顺手解锁音频，避免用户第一次收到回复时没声音。
  document.addEventListener('touchstart', unlockAudio, { once: true });
  document.addEventListener('click', unlockAudio, { once: true });

  // -------------------------------------------------------------------------
  // 模型与思考强度（2026-09-25 用户要求：手机上要能改每个会话的模型和强度）
  //
  // 顶栏那一行显示当前用的模型，点它弹出面板可以改。强度按当前模型自己声明的
  // 档位长；模型不支持调强度时那一行不出现。
  //
  // **位置很重要**：必须写在这个外层函数**里面**——`state` 是它内部的变量，
  // 写到 `})();` 后面就看不见了，结果会是「永远不显示」而且一句错都不报。
  // 另外**不能再开一个 script 块**：这个页面的测试用贪婪正则抽取脚本，
  // 多一个块就会把中间的 HTML 整段当成 JS 解析。这个坑踩过一次，别再来一次。
  // -------------------------------------------------------------------------
  ;(function () {
    var bar = document.getElementById('modelBar')
    var text = document.getElementById('modelBarText')
    if (!bar || !text) return

    var catalog = null  // 服务端给的模型目录
    var current = null  // 服务端记的当前选择 {provider, model, reasoningEffort}
    // 上下文窗口用量 {used, window}，服务端给。取不到就是 null——那时整段不显示。
    var contextUsage = null
    // 刚改完、服务端还没确认的那个值。为什么要多这一个：服务端记的「当前模型」是在
    // **下一次请求**时才更新的，所以改完立刻回头去读，读到的还是旧名字。先信
    // set-model 的返回值，等服务端追上了再让它接管。
    var pending = null
    var busy = false   // 防止连点两下发出两个互相打架的请求

    // ---- 顶栏 ------------------------------------------------------------
    function groupName(id) {
      var gs = (catalog && catalog.groups) || []
      for (var i = 0; i < gs.length; i++) { if (gs[i].id === id) return gs[i].name }
      return id || ''
    }
    /**
     * 上下文用量那一句人话。**不编**：分子分母缺任一个就返回空串，界面据此整段不显示
     * （和「模型：还没问到」同一条口径——不知道就说不知道，不拿别的数凑）。
     *
     * 超过 100% 时按 100% 显示：它是"下一次请求大概要花多少"，压不压缩由电脑决定；
     * 把 105% 端给用户，只会让人以为哪里出错了。
     */
    function contextLabel(used, capacity) {
      if (typeof used !== 'number' || typeof capacity !== 'number') return ''
      if (!(used > 0) || !(capacity > 0)) return ''
      var pct = Math.round(used / capacity * 100)
      if (pct > 100) pct = 100
      return pct + '%'
    }

    function sel() { return pending || current || null }

    function renderBar() {
      var s = sel()
      if (!s || !s.model) {
        // 问不到这个会话用哪个模型时，如实说一句——既不装作没这个功能，也不编一个。
        // 点它还照样能打开面板挑一个，挑完就写得进去。
        text.textContent = '模型：还没问到'
        bar.style.display = 'flex'
        return
      }
      // 来源名要用 DSH 给的那个（「DeepSeek」「opencode go」「mimo」），不是内部 id
      var parts = [groupName(s.provider), s.model]
      if (s.reasoningEffort) parts.push('思考 ' + s.reasoningEffort)
      // 上下文用得怎么样。取不到就什么都不加——不显示 0%，也不写"未知"占位。
      var ctxText = contextLabel(contextUsage && contextUsage.used, contextUsage && contextUsage.window)
      if (ctxText) parts.push(ctxText)
      text.textContent = parts.join(' · ')
      bar.style.display = 'flex'
    }

    // ---- 选择面板 --------------------------------------------------------
    function el(tag, css, txt) {
      var e = document.createElement(tag)
      if (css) e.style.cssText = css
      if (txt != null) e.textContent = txt
      return e
    }
    var ROW = 'display:block;width:100%;text-align:left;background:none;border:0;font:inherit;'
      + 'color:inherit;padding:11px 2px;border-bottom:1px solid var(--line,#333)'
    var HEAD = 'padding:14px 2px 4px;font-size:12px;color:var(--dim,#888)'
    var CHIP = 'margin:0 6px 6px 0;padding:5px 13px;border:1px solid var(--line,#444);'
      + 'border-radius:var(--r,2px);background:none;font:inherit;color:inherit;font-size:13px'

    // 面板用代码建出来、挂在 body 末尾，而不是写进页面结构里——这样这一整块的
    // 改动全部落在脚本内部，不用动 HTML，也就不会碰到别的部分。
    var mask = el('div', 'position:fixed;inset:0;background:var(--scrim);z-index:69;display:none')
    var sheet = el('div', 'position:fixed;left:0;right:0;bottom:0;z-index:70;display:none;'
      + 'max-height:72vh;overflow-y:auto;background:var(--bg,#1b1b1b);'
      + 'border-top:1px solid var(--line,#444);border-radius:var(--r,2px) var(--r,2px) 0 0;'
      + 'padding:10px 14px calc(16px + env(safe-area-inset-bottom))')
    document.body.appendChild(mask)
    document.body.appendChild(sheet)

    function renderSheet() {
      sheet.textContent = ''
      var s = sel() || {}
      sheet.appendChild(el('div', 'font-size:13px;color:var(--dim,#888);padding:2px 2px 6px',
        '这个会话用哪个模型'))
      if (!catalog) { sheet.appendChild(el('div', 'padding:12px 2px', '还没读到模型列表。')); return }

      var groups = catalog.groups || []
      for (var gi = 0; gi < groups.length; gi++) {
        var grp = groups[gi]
        sheet.appendChild(el('div', HEAD, grp.name || grp.id))
        var models = grp.models || []
        for (var mi = 0; mi < models.length; mi++) {
          var mod = models[mi]
          var isCur = s.provider === grp.id && s.model === mod.id
          var b = el('button', ROW, (isCur ? '✓ ' : '') + (mod.name || mod.id))
          if (isCur) b.style.fontWeight = '600'
          b.addEventListener('click', picker(grp.id, mod.id))
          sheet.appendChild(b)

          // 强度只在**当前这个模型**下面出现，而且只画它自己声明的档位——DeepSeek 是
          // off/low/high/max，opencode 和 mimo 是 minimal…max，两套不一样，不能合并成
          // 一个统一的说法。模型没声明强度时（五十个里有四十三个）这里什么都不画，
          // 不给一个拖了没反应的控件。
          var r = mod.reasoning
          if (isCur && r && r.efforts && r.efforts.length) {
            var box = el('div', 'padding:8px 2px 12px;border-bottom:1px solid var(--line,#333)')
            for (var ei = 0; ei < r.efforts.length; ei++) {
              var ef = r.efforts[ei]
              var on = s.reasoningEffort === ef.id
              var c = el('button', CHIP + (on ? ';border-color:currentColor;font-weight:600' : ''),
                (on ? '✓ ' : '') + (ef.name || ef.id))
              c.addEventListener('click', picker(grp.id, mod.id, ef.id))
              box.appendChild(c)
            }
            sheet.appendChild(box)
          }
        }
      }

      // 某个来源读不到时如实说出来，不要假装整份目录都是全的
      var fails = catalog.failures || []
      for (var fi = 0; fi < fails.length; fi++) {
        sheet.appendChild(el('div', 'padding:10px 2px;font-size:13px;color:var(--dim,#888)',
          '⚠ ' + (fails[fi].name || fails[fi].id) + '：' + (fails[fi].message || '读不到')))
      }

      var close = el('button', ROW + ';border-bottom:0;text-align:center;color:var(--dim,#888)', '关闭')
      close.addEventListener('click', closeSheet)
      sheet.appendChild(close)
    }

    // 把参数用闭包封起来。循环里直接写回调会全都指向最后一项——这是老坑了。
    function picker(provider, model, effort) {
      return function () { if (!busy) pick(provider, model, effort) }
    }

    function pick(provider, model, effort) {
      var body = { provider: provider, model: model }
      if (effort) body.reasoningEffort = effort
      busy = true
      fetch('/mini/api/set-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (r) { return r.json().catch(function () { return null }) })
        .then(function (d) {
          busy = false
          if (!d || !d.ok) { alert('没改成：' + ((d && d.error) || '电脑那边没答应')); return }
          var v = d.selected || body
          pending = { provider: v.provider, model: v.model, reasoningEffort: v.reasoningEffort || null }
          renderBar()
          renderSheet()
        })
        .catch(function () { busy = false; alert('没改成：连不上电脑。') })
    }

    function openSheet() { renderSheet(); mask.style.display = 'block'; sheet.style.display = 'block' }
    function closeSheet() { mask.style.display = 'none'; sheet.style.display = 'none' }

    // ---- 读目录 ----------------------------------------------------------
    function load() {
      if (!state.entered) return
      fetch('/mini/api/models', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (d) {
          if (!d || !d.ok) return
          catalog = d
          // **问不到就说问不到，绝不用目录默认值兜底。**
          //
          // 上一版这里写的是「没记下就显示目录默认值」，看着体贴，实际是编的：
          // 目录那个默认值等于「上一次选过的模型」，于是用户切到一个用别的模型的
          // 会话，顶栏显示的还是上一个模型——一个像模像样的错答案，比空着坏得多。
          current = (d.current && d.current.model) ? d.current : null
          // 用量跟着模型一起回来（同一条接口）。**不校验内容**：给它什么显示什么，
          // 拿不准的由下面那个纯函数挡掉。刷新频率就是这一条接口的频率（15 秒一次）。
          contextUsage = d.context || null
          // 服务端追上了就撤掉本地那个临时值，之后一律以服务端的为准
          if (pending && current && current.provider === pending.provider
              && current.model === pending.model) pending = null
          renderBar()
          if (sheet.style.display !== 'none') renderSheet()
        })
        .catch(function () { /* 读不到就保持原样，不显示错的东西 */ })
    }

    bar.style.cursor = 'pointer'
    bar.addEventListener('click', openSheet)
    mask.addEventListener('click', closeSheet)

    // 手机切了会话要**立刻**跟上，不能等下面那个 15 秒的轮询——那段时间里顶栏显示的
    // 是上一个会话的模型，看上去就像新会话用错了模型。页面自己把「现在是哪个会话」
    // 存在 state.boundSessionId 里（状态广播一到就更新），盯着它很便宜。
    var lastSession = state.boundSessionId || null
    setInterval(function () {
      var id = state.boundSessionId || null
      if (id === lastSession) return
      lastSession = id
      pending = null   // 上一个会话身上那个临时值，跟这个会话没关系，必须扔掉
      load()
    }, 1000)

    load()
    // 在电脑上改了模型，手机这边也要跟上。**轮询很土，但这里是诚实的做法**：
    // 显示一个过期的模型名比不显示更糟——用户会以为自己改的没生效。
    setInterval(function () { if (!document.hidden) load() }, 15000)
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load() })
    // 上面那个轮询管"显示的东西新不新"，这个管"**手里这份页面**是不是过期了"——
    // 插件重启过就要刷一次，不然页面会拿着旧的切帧规则去切新的立绘（见 watchBuild 注释）。
    // 30 秒的间隔够用：它防的是"重启之后一直拿着旧页面"，不是实时性。
    setInterval(watchBuild, 30000)
    // 手机把页面挂到后台时定时器会被压住，切回来那一刻补一次检查。
    document.addEventListener('visibilitychange', function () { if (!document.hidden) watchBuild() })
  })();
})();
