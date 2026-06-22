using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Reflection;

namespace AfterMatchPlugin;

public enum AfmMatchState
{
    Waiting,
    ReadyCheck,
    Knife,
    SidePick,
    Live,
    Finished
}

public sealed class DamageLine
{
    public int ToDamage { get; set; }
    public int ToHits { get; set; }
    public int FromDamage { get; set; }
    public int FromHits { get; set; }
    public int LastHp { get; set; }
    public string Name { get; set; } = "Игрок";
}

public sealed class AgentConfig
{
    public string ApiUrl { get; set; } = "http://localhost:3000/api/match-agent";
    public string ServerId { get; set; } = "cs2-1";
    public string ServerToken { get; set; } = "CHANGE_ME";
    public float PollSeconds { get; set; } = 10.0f;
}

public sealed class AfterMatchPlugin : BasePlugin
{
    public override string ModuleName => "aftermatch!";
    public override string ModuleVersion => "0.4.4-heartbeat-autotick";
    public override string ModuleAuthor => "aftermatch!";
    public override string ModuleDescription => "aftermatch! CS2 match controller";

    private const int MaxPausesPerTeam = 4;
    private const float TacticalPauseDurationSeconds = 30.0f;
    private static readonly HttpClient Http = new();

    private AfmMatchState _state = AfmMatchState.Waiting;
    private AgentConfig _agent = new();
    private int? _currentMatchId;
    private bool _agentEnabled;
    private DateTime _nextAgentTickUtc = DateTime.MinValue;
    private bool _agentTickRunning;
    private readonly HashSet<ulong> _readySteamIds = new();
    private readonly Dictionary<ulong, Dictionary<ulong, DamageLine>> _roundDamage = new();

    private readonly HashSet<ulong> _allowedSteamIds = new();
    private readonly HashSet<ulong> _captainSteamIds = new();
    private readonly HashSet<ulong> _teamASteamIds = new();
    private readonly HashSet<ulong> _teamBSteamIds = new();
    private string? _assignedMap;
    private bool _allPlayersConnectedCountdownStarted;
    private int _readyTimeoutMinutes = 5;

    // Counter-Strike team numbers: 2 = T, 3 = CT.
    private readonly Dictionary<int, int> _pausesUsedByTeam = new()
    {
        [2] = 0,
        [3] = 0,
    };

    private bool _isPaused;
    private bool _pauseIsTechnical;
    private ulong? _pauseOwnerSteamId;
    private int? _pauseOwnerTeam;

    private bool _knifeRoundHandled;
    private string _knifeWinnerSide = "";
    private int? _knifeWinnerTeamNumber;

    public override void Load(bool hotReload)
    {
        Console.WriteLine("[aftermatch!] plugin loaded");
        LoadAgentConfig();

        AddCommand("css_afm_status", "Show aftermatch! match status", CmdStatus);
        AddCommand("css_afm_warmup_on", "Start infinite warmup and ready check", CmdWarmupOn);
        AddCommand("css_afm_warmup_off", "End warmup", CmdWarmupOff);
        AddCommand("css_afm_knife", "Start knife round", CmdKnife);
        AddCommand("css_afm_sidepick", "Start 60 second side-pick warmup", CmdSidePick);
        AddCommand("css_afm_live", "Start live match", CmdLive);
        AddCommand("css_afm_restart", "Restart match and reset pause counters", CmdRestart);
        AddCommand("css_afm_pause", "Start technical/admin pause until unpause", CmdTechPause);
        AddCommand("css_afm_tech", "Start technical/admin pause until unpause", CmdTechPause);
        AddCommand("css_afm_unpause", "Unpause match", CmdAdminUnpause);
        AddCommand("css_afm_swap", "Swap teams", CmdSwap);
        AddCommand("css_afm_kickbots", "Kick bots", CmdKickBots);
        AddCommand("css_afm_say", "Send aftermatch! chat message", CmdSay);
        AddCommand("css_afm_reset", "Reset aftermatch! state", CmdReset);
        AddCommand("css_afm_heartbeat", "Send aftermatch! heartbeat now", CmdHeartbeat);
        AddCommand("css_afm_agent_tick", "Run aftermatch! agent tick now", CmdAgentTickCommand);

        // Chat commands via CSS bridge.
        AddCommand("css_ready", "Captain ready", CmdReady);
        AddCommand("css_pause", "Request tactical pause", CmdPlayerPause);
        AddCommand("css_tech", "Request technical pause", CmdPlayerTechPause);
        AddCommand("css_unpause", "Remove own pause", CmdPlayerUnpause);
        AddCommand("css_t", "Choose Terrorist side", CmdChooseT);
        AddCommand("css_ct", "Choose Counter-Terrorist side", CmdChooseCT);

        // Dot/direct chat fallback: .t, .ct, !ready, !pause, !tech, !unpause.
        AddCommandListener("say", OnSayCommand);
        AddCommandListener("say_team", OnSayCommand);

        RegisterEventHandler<EventPlayerHurt>(OnPlayerHurt);
        RegisterEventHandler<EventRoundEnd>(OnRoundEnd);
        RegisterListener<Listeners.OnTick>(OnServerTick);

        if (_agentEnabled)
        {
            Console.WriteLine($"[aftermatch!] agent enabled: api='{_agent.ApiUrl.TrimEnd('/')}', serverId='{_agent.ServerId}', pollSeconds={_agent.PollSeconds}");
            SendHeartbeat(verbose: true);
            PollAssignment(verbose: true);
            SendAgentEvent("PLUGIN_LOADED", new { version = ModuleVersion, hotReload });
            _nextAgentTickUtc = DateTime.UtcNow.AddSeconds(Math.Max(3.0f, _agent.PollSeconds));
            Console.WriteLine("[aftermatch!] automatic heartbeat enabled via OnTick.");
        }
        else
        {
            Console.WriteLine("[aftermatch!] agent disabled: check ApiUrl/ServerToken in aftermatch.json");
        }

        if (hotReload)
            SayAll("Плагин aftermatch! перезагружен.");
    }


    private void LoadAgentConfig()
    {
        var assemblyDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? AppContext.BaseDirectory;

        var candidates = new[]
        {
            // Main path: next to AfterMatchPlugin.dll
            Path.Combine(assemblyDir, "aftermatch.json"),

            // Common CounterStrikeSharp / CS2 launch paths
            Path.Combine(AppContext.BaseDirectory, "aftermatch.json"),
            Path.Combine(Directory.GetCurrentDirectory(), "aftermatch.json"),
            Path.Combine(Directory.GetCurrentDirectory(), "game", "csgo", "addons", "counterstrikesharp", "plugins", "AfterMatch", "aftermatch.json"),
            Path.Combine(Directory.GetCurrentDirectory(), "csgo", "addons", "counterstrikesharp", "plugins", "AfterMatch", "aftermatch.json"),
            Path.Combine(Directory.GetCurrentDirectory(), "addons", "counterstrikesharp", "plugins", "AfterMatch", "aftermatch.json"),
        };

        Console.WriteLine($"[aftermatch!] config search: current='{Directory.GetCurrentDirectory()}', base='{AppContext.BaseDirectory}', assembly='{assemblyDir}'");

        foreach (var path in candidates)
        {
            if (!File.Exists(path))
                continue;

            try
            {
                var json = File.ReadAllText(path);
                _agent = JsonSerializer.Deserialize<AgentConfig>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new AgentConfig();
                _agentEnabled = !string.IsNullOrWhiteSpace(_agent.ApiUrl) && !string.IsNullOrWhiteSpace(_agent.ServerToken) && _agent.ServerToken != "CHANGE_ME";
                Console.WriteLine($"[aftermatch!] agent config loaded: {path}, enabled={_agentEnabled}");
                return;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[aftermatch!] failed to read agent config {path}: {ex.Message}");
            }
        }

        Console.WriteLine("[aftermatch!] aftermatch.json not found; website integration disabled. Checked paths:");
        foreach (var path in candidates)
            Console.WriteLine($"[aftermatch!] - {path}");
    }

    private void OnServerTick()
    {
        if (!_agentEnabled)
            return;

        var now = DateTime.UtcNow;
        if (now < _nextAgentTickUtc)
            return;

        _nextAgentTickUtc = now.AddSeconds(Math.Max(3.0f, _agent.PollSeconds));
        RunAgentTick("auto");
    }

    private void RunAgentTick(string source)
    {
        if (!_agentEnabled)
            return;

        if (_agentTickRunning)
        {
            Console.WriteLine($"[aftermatch!] agent tick skipped ({source}): previous tick is still running");
            return;
        }

        _agentTickRunning = true;
        Console.WriteLine($"[aftermatch!] agent tick ({source})");

        try
        {
            SendHeartbeat(verbose: false);
            PollAssignment(verbose: false);
            EnforceWhitelistAndConnectionFlow();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[aftermatch!] agent tick failed: {ex.Message}");
        }
        finally
        {
            _agentTickRunning = false;
        }
    }

    private void SendHeartbeat(bool verbose = false)
    {
        // CounterStrikeSharp/CS2 native API can only be touched from the main server thread.
        // So we collect server/player data before starting the HTTP task.
        int playersOnline;
        string status;
        int? matchId;

        try
        {
            playersOnline = Utilities.GetPlayers().Count(p => p is { IsValid: true } && !p.IsBot);
            status = _state.ToString().ToUpperInvariant();
            matchId = _currentMatchId;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[aftermatch!] heartbeat collect failed: {ex.Message}");
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                var url = $"{_agent.ApiUrl.TrimEnd('/')}/heartbeat?serverId={Uri.EscapeDataString(_agent.ServerId)}";
                if (verbose) Console.WriteLine($"[aftermatch!] heartbeat POST {url}");
                var responseText = await PostJson("heartbeat", new { serverId = _agent.ServerId, status, playersOnline, matchId });
                Console.WriteLine($"[aftermatch!] heartbeat ok: {responseText}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[aftermatch!] heartbeat failed: {ex.Message}");
            }
        });
    }

    private void PollAssignment(bool verbose = false)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                var url = $"{_agent.ApiUrl.TrimEnd('/')}/assignment?serverId={Uri.EscapeDataString(_agent.ServerId)}";
                if (verbose) Console.WriteLine($"[aftermatch!] assignment GET {url}");
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _agent.ServerToken);
                using var response = await Http.SendAsync(request);
                var text = await response.Content.ReadAsStringAsync();
                if (!response.IsSuccessStatusCode)
                {
                    Console.WriteLine($"[aftermatch!] assignment failed: {(int)response.StatusCode} {text}");
                    return;
                }

                using var doc = JsonDocument.Parse(text);
                if (!doc.RootElement.TryGetProperty("assigned", out var assigned) || !assigned.GetBoolean())
                {
                    if (verbose) Console.WriteLine("[aftermatch!] assignment: no active match assigned");
                    return;
                }

                var match = doc.RootElement.GetProperty("match");
                var matchId = match.GetProperty("id").GetInt32();
                var teamA = match.GetProperty("teamA").GetString() ?? "Team A";
                var teamB = match.GetProperty("teamB").GetString() ?? "Team B";
                var map = match.TryGetProperty("map", out var mapEl) ? mapEl.GetString() : null;
                var password = match.TryGetProperty("connectPassword", out var passEl) ? passEl.GetString() : null;
                _readyTimeoutMinutes = match.TryGetProperty("readyTimeoutMinutes", out var readyEl) && readyEl.TryGetInt32(out var readyMinutes) ? Math.Max(1, readyMinutes) : 5;

                UpdateAssignmentSteamLists(match);

                var newMatch = _currentMatchId != matchId;
                var mapChanged = !string.IsNullOrWhiteSpace(map) && !string.Equals(_assignedMap, map, StringComparison.OrdinalIgnoreCase);
                if (!newMatch && !mapChanged)
                    return;

                _currentMatchId = matchId;
                _assignedMap = map;

                Server.NextFrame(() =>
                {
                    ApplyBaseMatchCvars();
                    if (!string.IsNullOrWhiteSpace(password))
                        Exec($"sv_password {password}");
                    if (mapChanged && !string.IsNullOrWhiteSpace(map))
                        Exec($"changelevel {map}");
                    SayAll($"Назначен матч #{matchId}: {teamA} vs {teamB}.");
                    StartReadyCheckWarmup();
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[aftermatch!] assignment poll failed: {ex.Message}");
            }
        });
    }

    private void SendAgentEvent(string type, object? payload = null)
    {
        if (!_agentEnabled)
            return;

        _ = Task.Run(async () =>
        {
            try
            {
                await PostJson("events", new { serverId = _agent.ServerId, matchId = _currentMatchId, type, payload = payload ?? new { } });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[aftermatch!] event {type} failed: {ex.Message}");
            }
        });
    }

    private async Task<string> PostJson(string endpoint, object payload)
    {
        var json = JsonSerializer.Serialize(payload);
        var url = $"{_agent.ApiUrl.TrimEnd('/')}/{endpoint}?serverId={Uri.EscapeDataString(_agent.ServerId)}";
        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _agent.ServerToken);
        request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await Http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
            throw new Exception($"POST {url} -> HTTP {(int)response.StatusCode}: {text}");
        return text;
    }

    private HookResult OnSayCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid)
            return HookResult.Continue;

        var text = (info.ArgString ?? string.Empty).Trim();
        text = text.Trim('"').Trim().ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(text))
            return HookResult.Continue;

        switch (text)
        {
            case "!ready":
                HandleReady(player);
                return HookResult.Handled;
            case "!pause":
                RequestTacticalPause(player);
                return HookResult.Handled;
            case "!tech":
                RequestTechnicalPause(player);
                return HookResult.Handled;
            case "!unpause":
                RequestPlayerUnpause(player);
                return HookResult.Handled;
            case ".t":
            case "!t":
                ChooseSide(player, "T");
                return HookResult.Handled;
            case ".ct":
            case "!ct":
                ChooseSide(player, "CT");
                return HookResult.Handled;
            default:
                return HookResult.Continue;
        }
    }

    private void CmdStatus(CCSPlayerController? player, CommandInfo info)
    {
        var pauseOwner = _pauseOwnerSteamId?.ToString() ?? "нет";
        Reply(player, $"Статус: {_state}. Ready: {_readySteamIds.Count}/2. Паузы T: {_pausesUsedByTeam[2]}/{MaxPausesPerTeam}, CT: {_pausesUsedByTeam[3]}/{MaxPausesPerTeam}. Активная пауза: {_isPaused}, тех: {_pauseIsTechnical}, owner: {pauseOwner}.");
    }

    private void CmdWarmupOn(CCSPlayerController? player, CommandInfo info) => StartReadyCheckWarmup();

    private void CmdWarmupOff(CCSPlayerController? player, CommandInfo info)
    {
        Exec("mp_warmup_end");
        SayAll("Разминка завершена.");
    }

    private void CmdKnife(CCSPlayerController? player, CommandInfo info) => StartKnifeRound();

    private void CmdSidePick(CCSPlayerController? player, CommandInfo info) => StartSidePickWarmup();

    private void CmdLive(CCSPlayerController? player, CommandInfo info) => StartLiveMatch();

    private void CmdRestart(CCSPlayerController? player, CommandInfo info)
    {
        ResetPerMatchCounters();
        _state = AfmMatchState.Live;
        Exec("mp_restartgame 1");
        SayAll("Матч перезапущен. Лимиты пауз сброшены.");
    }

    // Console command: admin/technical pause, no 30-second timer and no team limit.
    private void CmdTechPause(CCSPlayerController? player, CommandInfo info) => RequestTechnicalPause(player);

    private void CmdAdminUnpause(CCSPlayerController? player, CommandInfo info) => ForceUnpause("Пауза отключена администратором.");

    private void CmdSwap(CCSPlayerController? player, CommandInfo info)
    {
        Exec("mp_swapteams");
        Exec("mp_restartgame 1");
        SayAll("Стороны сменены.");
    }

    private void CmdKickBots(CCSPlayerController? player, CommandInfo info)
    {
        Exec("bot_kick");
        SayAll("Боты кикнуты.");
    }

    private void CmdSay(CCSPlayerController? player, CommandInfo info)
    {
        var message = (info.ArgString ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(message))
        {
            Reply(player, "Использование: css_afm_say текст сообщения");
            return;
        }

        SayAll(message);
    }

    private void CmdHeartbeat(CCSPlayerController? player, CommandInfo info)
    {
        Reply(player, "Отправляю heartbeat на сайт. Проверьте консоль сервера.");
        SendHeartbeat(verbose: true);
    }

    private void CmdAgentTickCommand(CCSPlayerController? player, CommandInfo info)
    {
        Reply(player, "Запускаю agent tick вручную. Проверьте консоль сервера.");
        RunAgentTick("manual");
    }

    private void CmdReset(CCSPlayerController? player, CommandInfo info)
    {
        _state = AfmMatchState.Waiting;
        _readySteamIds.Clear();
        _roundDamage.Clear();
        ResetPerMatchCounters();
        SayAll("Состояние aftermatch! сброшено.");
    }

    private void CmdReady(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid)
            return;
        HandleReady(player);
    }

    private void CmdPlayerPause(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid)
            return;
        RequestTacticalPause(player);
    }

    private void CmdPlayerTechPause(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid)
            return;
        RequestTechnicalPause(player);
    }

    private void CmdPlayerUnpause(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid)
            return;
        RequestPlayerUnpause(player);
    }

    private void CmdChooseT(CCSPlayerController? player, CommandInfo info) => ChooseSide(player, "T");

    private void CmdChooseCT(CCSPlayerController? player, CommandInfo info) => ChooseSide(player, "CT");

    private void StartReadyCheckWarmup()
    {
        _state = AfmMatchState.ReadyCheck;
        _readySteamIds.Clear();
        _roundDamage.Clear();
        ResetPerMatchCounters();

        _allPlayersConnectedCountdownStarted = false;
        ApplyBaseMatchCvars();
        Exec("mp_warmup_start");
        Exec("mp_warmuptime 300");
        Exec("mp_warmup_pausetimer 0");
        Exec("mp_restartgame 1");

        SayAll("Разминка 5 минут на подключение игроков. После подключения всех игроков ножевой начнётся автоматически через 15 секунд.");
        SayAll("Капитаны могут написать !ready для ручного подтверждения готовности.");
        SendAgentEvent("READY_CHECK_STARTED", new { state = _state.ToString() });
    }

    private void HandleReady(CCSPlayerController player)
    {
        if (_state != AfmMatchState.ReadyCheck)
        {
            Reply(player, "Сейчас подтверждение готовности недоступно.");
            return;
        }

        if (!IsCaptain(player))
        {
            Reply(player, "Готовность может подтвердить только капитан команды.");
            return;
        }

        var steamId = player.SteamID;
        if (!_readySteamIds.Add(steamId))
        {
            Reply(player, "Вы уже подтвердили готовность.");
            return;
        }

        SayAll($"{SafeName(player)} подтвердил готовность ({_readySteamIds.Count}/2).");

        if (_readySteamIds.Count >= 2)
        {
            SayAll("Обе стороны готовы. Запускаем ножевой раунд.");
            StartKnifeRound();
        }
    }

    private void StartKnifeRound()
    {
        _state = AfmMatchState.Knife;
        _knifeRoundHandled = false;
        _knifeWinnerSide = "";
        _knifeWinnerTeamNumber = null;
        _roundDamage.Clear();

        Exec("mp_warmup_end");
        Exec("mp_freezetime 0");
        Exec("mp_buytime 0");
        Exec("mp_startmoney 0");
        Exec("mp_maxmoney 0");
        Exec("mp_ct_default_primary \"\"");
        Exec("mp_ct_default_secondary \"\"");
        Exec("mp_t_default_primary \"\"");
        Exec("mp_t_default_secondary \"\"");
        Exec("mp_give_player_c4 0");
        Exec("mp_restartgame 1");

        SayAll("Ножевой раунд начался.");
        SendAgentEvent("KNIFE_STARTED", new { state = _state.ToString() });
    }

    private void StartSidePickWarmup()
    {
        _state = AfmMatchState.SidePick;
        _roundDamage.Clear();

        Exec("mp_warmup_start");
        Exec("mp_warmuptime 60");
        Exec("mp_warmup_pausetimer 0");
        Exec("mp_restartgame 1");

        SayAll("Капитан победившей стороны: напишите .t или .ct для выбора стороны.");
        SendAgentEvent("SIDE_PICK_STARTED", new { winnerSide = _knifeWinnerSide });
    }

    private void ChooseSide(CCSPlayerController? player, string side)
    {
        if (player is null || !player.IsValid)
            return;

        if (_state != AfmMatchState.SidePick)
        {
            Reply(player, "Выбор стороны сейчас недоступен.");
            return;
        }

        if (!IsCaptain(player))
        {
            Reply(player, "Выбор стороны доступен только капитану команды.");
            return;
        }

        var playerTeam = GetPlayerTeamNumber(player);
        if (_knifeWinnerTeamNumber is not null && playerTeam != _knifeWinnerTeamNumber.Value)
        {
            Reply(player, "Выбор стороны доступен только игрокам стороны, выигравшей ножевой раунд.");
            return;
        }

        if (string.IsNullOrWhiteSpace(_knifeWinnerSide))
        {
            Reply(player, "Победитель ножевого раунда не определён. Выбор стороны недоступен.");
            return;
        }

        if (!string.Equals(_knifeWinnerSide, side, StringComparison.OrdinalIgnoreCase))
        {
            Exec("mp_swapteams");
            SayAll($"{SafeName(player)} выбрал сторону {side}. Стороны сменены.");
        }
        else
        {
            SayAll($"{SafeName(player)} выбрал сторону {side}. Стороны остаются без изменений.");
        }

        StartLiveMatch();
    }

    private void StartLiveMatch()
    {
        _state = AfmMatchState.Live;
        _roundDamage.Clear();
        ClearActivePause();

        Exec("mp_warmup_end");
        Exec("mp_freezetime 15");
        Exec("mp_buytime 20");
        Exec("mp_startmoney 800");
        Exec("mp_maxmoney 16000");
        Exec("mp_give_player_c4 1");
        Exec("mp_ct_default_primary \"\"");
        Exec("mp_ct_default_secondary weapon_hkp2000");
        Exec("mp_t_default_primary \"\"");
        Exec("mp_t_default_secondary weapon_glock");
        Exec("mp_overtime_enable 1");
        Exec("mp_restartgame 3");

        SayAll("Матч начался. GL HF!");
        SendAgentEvent("MATCH_STARTED", new { state = _state.ToString() });
    }

    private void RequestTacticalPause(CCSPlayerController? player)
    {
        if (player is null || !player.IsValid)
            return;

        if (_state != AfmMatchState.Live)
        {
            Reply(player, "Паузу можно поставить только во время live-матча.");
            return;
        }

        if (_isPaused)
        {
            Reply(player, "Пауза уже активна.");
            return;
        }

        var team = GetPlayerTeamNumber(player);
        if (team is not (2 or 3))
        {
            Reply(player, "Паузу может поставить только игрок команды T или CT.");
            return;
        }

        var used = _pausesUsedByTeam[team];
        if (used >= MaxPausesPerTeam)
        {
            Reply(player, $"Лимит пауз вашей команды исчерпан: {MaxPausesPerTeam}/{MaxPausesPerTeam}.");
            return;
        }

        _pausesUsedByTeam[team] = used + 1;
        SetActivePause(player, team, technical: false);

        Exec("mp_pause_match");

        SayAll($"{SafeName(player)} поставил тактическую паузу на 30 секунд. Команда {TeamName(team)}: {_pausesUsedByTeam[team]}/{MaxPausesPerTeam}.");
        SendAgentEvent("PAUSE_STARTED", new { kind = "TACTICAL", team = TeamName(team), owner = SafeName(player), used = _pausesUsedByTeam[team], limit = MaxPausesPerTeam });

        AddTimer(TacticalPauseDurationSeconds, () =>
        {
            if (!_isPaused || _pauseIsTechnical)
                return;

            ForceUnpause("Тактическая пауза завершена. Матч продолжается.");
        });
    }

    private void RequestTechnicalPause(CCSPlayerController? player)
    {
        if (_state != AfmMatchState.Live)
        {
            Reply(player, "Техническую паузу можно поставить только во время live-матча.");
            return;
        }

        if (_isPaused)
        {
            Reply(player, "Пауза уже активна.");
            return;
        }

        int? team = null;
        if (player is { IsValid: true })
        {
            var playerTeam = GetPlayerTeamNumber(player);
            if (playerTeam is 2 or 3)
                team = playerTeam;
        }

        SetActivePause(player, team, technical: true);
        Exec("mp_pause_match");

        var who = player is { IsValid: true } ? SafeName(player) : "Администратор";
        SayAll($"{who} поставил техническую паузу. Для снятия используйте !unpause.");
        SendAgentEvent("PAUSE_STARTED", new { kind = "TECH", team = team is null ? null : TeamName(team.Value), owner = who });
    }

    private void RequestPlayerUnpause(CCSPlayerController player)
    {
        if (!_isPaused)
        {
            Reply(player, "Активной паузы нет.");
            return;
        }

        if (_pauseOwnerSteamId is not null && _pauseOwnerSteamId.Value != player.SteamID)
        {
            Reply(player, "Снять паузу может только игрок, который её поставил.");
            return;
        }

        ForceUnpause($"{SafeName(player)} снял паузу. Матч продолжается.");
    }

    private void SetActivePause(CCSPlayerController? owner, int? team, bool technical)
    {
        _isPaused = true;
        _pauseIsTechnical = technical;
        _pauseOwnerSteamId = owner is { IsValid: true } ? owner.SteamID : null;
        _pauseOwnerTeam = team;
    }

    private void ForceUnpause(string message)
    {
        ClearActivePause();
        Exec("mp_unpause_match");
        SayAll(message);
        SendAgentEvent("PAUSE_ENDED", new { message });
    }

    private void ClearActivePause()
    {
        _isPaused = false;
        _pauseIsTechnical = false;
        _pauseOwnerSteamId = null;
        _pauseOwnerTeam = null;
    }

    private void ResetPerMatchCounters()
    {
        _pausesUsedByTeam[2] = 0;
        _pausesUsedByTeam[3] = 0;
        ClearActivePause();
    }

    public HookResult OnPlayerHurt(EventPlayerHurt @event, GameEventInfo info)
    {
        if (_state is not (AfmMatchState.Knife or AfmMatchState.Live))
            return HookResult.Continue;

        var victim = @event.Userid;
        var attacker = @event.Attacker;

        if (victim is null || attacker is null || !victim.IsValid || !attacker.IsValid)
            return HookResult.Continue;

        if (victim.SteamID == attacker.SteamID)
            return HookResult.Continue;

        var damage = Math.Max(0, @event.DmgHealth);
        var hp = Math.Max(0, @event.Health);

        AddDamage(attacker, victim, damage, hp, dealt: true);
        AddDamage(victim, attacker, damage, hp, dealt: false);

        return HookResult.Continue;
    }

    public HookResult OnRoundEnd(EventRoundEnd @event, GameEventInfo info)
    {
        if (_state is AfmMatchState.Knife or AfmMatchState.Live)
            PrintDamageReport();

        SendAgentEvent("ROUND_END", new { winner = @event.Winner, state = _state.ToString() });

        if (_state == AfmMatchState.Knife && !_knifeRoundHandled)
        {
            _knifeRoundHandled = true;
            _knifeWinnerTeamNumber = @event.Winner is 2 or 3 ? @event.Winner : null;
            _knifeWinnerSide = @event.Winner == 2 ? "T" : @event.Winner == 3 ? "CT" : "";

            if (string.IsNullOrWhiteSpace(_knifeWinnerSide))
                SayAll("Ножевой раунд завершён. Победитель стороны не определён.");
            else
                SayAll($"Ножевой раунд выиграла сторона {_knifeWinnerSide}.");

            SendAgentEvent("KNIFE_FINISHED", new { winnerSide = _knifeWinnerSide, winnerTeam = _knifeWinnerTeamNumber });

            AddTimer(3.0f, StartSidePickWarmup);
        }

        _roundDamage.Clear();
        return HookResult.Continue;
    }

    private void AddDamage(CCSPlayerController owner, CCSPlayerController opponent, int damage, int opponentHp, bool dealt)
    {
        if (!_roundDamage.TryGetValue(owner.SteamID, out var lines))
        {
            lines = new Dictionary<ulong, DamageLine>();
            _roundDamage[owner.SteamID] = lines;
        }

        if (!lines.TryGetValue(opponent.SteamID, out var line))
        {
            line = new DamageLine { Name = SafeName(opponent), LastHp = opponentHp };
            lines[opponent.SteamID] = line;
        }

        line.Name = SafeName(opponent);
        line.LastHp = opponentHp;

        if (dealt)
        {
            line.ToDamage += damage;
            line.ToHits += 1;
        }
        else
        {
            line.FromDamage += damage;
            line.FromHits += 1;
        }
    }

    private void PrintDamageReport()
    {
        foreach (var player in Utilities.GetPlayers())
        {
            if (player is null || !player.IsValid || player.IsBot)
                continue;

            if (!_roundDamage.TryGetValue(player.SteamID, out var lines) || lines.Count == 0)
                continue;

            foreach (var line in lines.Values.Take(5))
            {
                player.PrintToChat($" \x0B[aftermatch!]\x01 To: [{line.ToDamage} / {line.ToHits} hits] From: [{line.FromDamage} / {line.FromHits} hits] - {line.Name} ({line.LastHp} hp)");
            }
        }
    }


    private void ApplyBaseMatchCvars()
    {
        Exec("mp_autoteambalance 0");
        Exec("mp_limitteams 0");
        Exec("sv_vote_issue_kick_allowed 0");
        Exec("sv_vote_issue_pause_match_allowed 0");
        Exec("mp_team_timeout_max 0");
        Exec("mp_team_timeout_time 0");
    }

    private void UpdateAssignmentSteamLists(JsonElement match)
    {
        _allowedSteamIds.Clear();
        _captainSteamIds.Clear();
        _teamASteamIds.Clear();
        _teamBSteamIds.Clear();

        if (match.TryGetProperty("whitelist", out var whitelist) && whitelist.ValueKind == JsonValueKind.Array)
            foreach (var item in whitelist.EnumerateArray()) AddSteamId(_allowedSteamIds, item.GetString());
        if (match.TryGetProperty("captains", out var captains) && captains.ValueKind == JsonValueKind.Array)
            foreach (var item in captains.EnumerateArray()) AddSteamId(_captainSteamIds, item.GetString());

        ReadTeamPlayers(match, "teamAData", _teamASteamIds);
        ReadTeamPlayers(match, "teamBData", _teamBSteamIds);
    }

    private static void ReadTeamPlayers(JsonElement match, string property, HashSet<ulong> target)
    {
        if (!match.TryGetProperty(property, out var team) || team.ValueKind != JsonValueKind.Object)
            return;
        if (!team.TryGetProperty("players", out var players) || players.ValueKind != JsonValueKind.Array)
            return;
        foreach (var player in players.EnumerateArray())
            if (player.TryGetProperty("steamId", out var steam)) AddSteamId(target, steam.GetString());
    }

    private static void AddSteamId(HashSet<ulong> set, string? value)
    {
        if (ulong.TryParse(value, out var steamId)) set.Add(steamId);
    }

    private bool IsCaptain(CCSPlayerController player)
    {
        // Если сайт ещё не передал captains, оставляем ручной режим для тестов.
        return _captainSteamIds.Count == 0 || _captainSteamIds.Contains(player.SteamID);
    }

    private void EnforceWhitelistAndConnectionFlow()
    {
        var players = Utilities.GetPlayers().Where(p => p is { IsValid: true } && !p.IsBot).ToList();

        foreach (var player in players)
        {
            if (_allowedSteamIds.Count > 0 && !_allowedSteamIds.Contains(player.SteamID))
            {
                Reply(player, "Вы не участвуете в этом матче.");
                Exec($"kickid {player.UserId} Only tournament players are allowed");
                continue;
            }

            if (_teamASteamIds.Contains(player.SteamID) && player.TeamNum != 3)
                player.ChangeTeam(CsTeam.CounterTerrorist);
            if (_teamBSteamIds.Contains(player.SteamID) && player.TeamNum != 2)
                player.ChangeTeam(CsTeam.Terrorist);
        }

        if (_state != AfmMatchState.ReadyCheck || _allPlayersConnectedCountdownStarted || _allowedSteamIds.Count == 0)
            return;

        var connected = players.Select(p => p.SteamID).ToHashSet();
        var allConnected = _allowedSteamIds.All(connected.Contains);
        if (!allConnected)
            return;

        _allPlayersConnectedCountdownStarted = true;
        SayAll("Все игроки подключились. Ножевой раунд начнётся через 15 секунд.");
        Exec("mp_warmuptime 15");
        Exec("mp_warmup_pausetimer 0");
        AddTimer(15.0f, () =>
        {
            if (_state == AfmMatchState.ReadyCheck)
                StartKnifeRound();
        });
    }

    private static int GetPlayerTeamNumber(CCSPlayerController player)
    {
        // CounterStrikeSharp 1.0.369 exposes TeamNum on CCSPlayerController in normal builds.
        // 2 = Terrorists, 3 = Counter-Terrorists.
        return player.TeamNum;
    }

    private static string TeamName(int team) => team switch
    {
        2 => "T",
        3 => "CT",
        _ => "Unknown"
    };

    private static string SafeName(CCSPlayerController player)
    {
        return string.IsNullOrWhiteSpace(player.PlayerName) ? "Игрок" : player.PlayerName;
    }

    private static void Exec(string command)
    {
        Console.WriteLine($"[aftermatch!] exec: {command}");
        Server.ExecuteCommand(command);
    }

    private static void SayAll(string message)
    {
        Server.PrintToChatAll($" \x0B[aftermatch!]\x01 {message}");
    }

    private static void Reply(CCSPlayerController? player, string message)
    {
        if (player is { IsValid: true })
            player.PrintToChat($" \x0B[aftermatch!]\x01 {message}");
        else
            Console.WriteLine($"[aftermatch!] {message}");
    }
}
