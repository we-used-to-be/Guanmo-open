use super::*;

pub(crate) fn verify_oauth_storage() {
    let path = std::env::temp_dir()
        .join(format!(
            "guanmo-mcp-oauth-{}-{}",
            std::process::id(),
            new_id("test")
        ))
        .join("mcp-servers.json");
    let id = "oauth-storage";
    let url = "https://anonymous.example/mcp";
    let update = |url: &str| SaveServer {
        config: ServerConfig::Http(HttpConfig {
            transport: HttpTransport::Http,
            server_id: id.into(),
            url: url.into(),
        }),
        name: "Anonymous OAuth".into(),
        env_changes: BTreeMap::new(),
    };
    save(&path, update(url)).unwrap();
    let raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(raw["servers"][0].get("oauth").is_none());
    let bytes = br#"{"access_token":"anonymous-secret-token"}"#;
    let cancel = CancellationToken::new();
    assert_eq!(
        save_oauth_bytes(&path, id, url, bytes, &cancel).err(),
        Some("MCP_CONFIG_CHANGED")
    );
    change(&path, id, Some(true)).unwrap();
    save_oauth_bytes(&path, id, url, bytes, &cancel).unwrap();
    assert_eq!(
        load_oauth_bytes(&path, id, url).unwrap().as_deref(),
        Some(bytes.as_slice())
    );
    assert!(!fs::read_to_string(&path)
        .unwrap()
        .contains("anonymous-secret-token"));
    let listed = serde_json::to_value(views(read(&path).unwrap()).unwrap()).unwrap();
    assert_eq!(listed[0]["authorizationStatus"], "authorized");
    assert!(listed[0].get("oauth").is_none());
    RUNTIME.lock().unwrap().authorizations.insert(
        id.into(),
        AuthorizationOperation {
            server_id: id.into(),
            request_id: "anonymous-auth".into(),
            cancel: cancel.clone(),
        },
    );
    change(&path, id, Some(false)).unwrap();
    assert!(cancel.is_cancelled());
    assert!(read(&path).unwrap().servers[0].oauth.is_none());
    change(&path, id, Some(true)).unwrap();
    assert_eq!(
        save_oauth_bytes(&path, id, url, bytes, &cancel).err(),
        Some("MCP_CANCELLED")
    );
    let fresh = CancellationToken::new();
    save_oauth_bytes(&path, id, url, bytes, &fresh).unwrap();
    clear_oauth(&path, id).unwrap();
    assert!(load_oauth_bytes(&path, id, url).unwrap().is_none());
    save_oauth_bytes(&path, id, url, bytes, &fresh).unwrap();
    save(&path, update("https://anonymous.example/edited")).unwrap();
    assert!(read(&path).unwrap().servers[0].oauth.is_none());
    assert_eq!(
        save_oauth_bytes(&path, id, url, bytes, &fresh).err(),
        Some("MCP_CONFIG_CHANGED")
    );
    change(&path, id, None).unwrap();
    assert_eq!(
        save_oauth_bytes(&path, id, url, bytes, &fresh).err(),
        Some("MCP_SERVER_MISSING")
    );
}

/// Runs inside the single MCP runtime test, avoiding competing global shutdowns.
pub(crate) fn verify() {
    let root = std::env::temp_dir().join(format!(
        "guanmo-mcp-config-{}-{}",
        std::process::id(),
        new_id("test")
    ));
    let path = root.join("mcp-servers.json");
    assert!(read(&path).unwrap().servers.is_empty());
    assert!(!root.exists()); // An empty installation does no I/O beyond reading.
    let config = super::super::tests::fixture("modern");
    let id = config.server_id.clone();
    let update = |env_changes| SaveServer {
        config: ServerConfig::Stdio(config.clone()),
        name: "Anonymous fixture".into(),
        env_changes,
    };
    save(
        &path,
        update(BTreeMap::from([(
            "TOKEN".into(),
            Some("anonymous-sentinel-value".into()),
        )])),
    )
    .unwrap();
    let store = read(&path).unwrap();
    let raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(raw["servers"][0]["config"].get("transport").is_none());
    assert!(!store.servers[0].enabled);
    assert!(!fs::read_to_string(&path)
        .unwrap()
        .contains("anonymous-sentinel-value"));
    let ciphertext = store.servers[0].env["TOKEN"].clone();
    assert_eq!(
        crate::secret_protection::unprotect_secret(&ciphertext).unwrap(),
        "anonymous-sentinel-value"
    );
    let view = serde_json::to_value(views(store).unwrap()).unwrap();
    assert_eq!(view[0]["envNames"], serde_json::json!(["TOKEN"]));
    assert!(view[0].get("env").is_none());
    assert!(!view.to_string().contains("anonymous-sentinel-value"));
    assert!(matches!(
        connection(&path, &id, "disabled-request"),
        Err("MCP_SERVER_DISABLED")
    ));

    // Saving a non-secret field must retain the existing ciphertext byte-for-byte.
    save(&path, update(BTreeMap::new())).unwrap();
    assert_eq!(read(&path).unwrap().servers[0].env["TOKEN"], ciphertext);
    change(&path, &id, Some(true)).unwrap();
    let (s, _, env, _) = connection(&path, &id, "config-request").unwrap();
    assert_eq!(env["TOKEN"], "anonymous-sentinel-value");
    assert!(s.client.lock().unwrap().is_none()); // Enable/reserve does not spawn.
    let proposal = Proposal {
        session: s.clone(),
        revision: "old".into(),
        epoch: 0,
        name: "echo".into(),
        arguments: Value::Object(Default::default()),
        expires: Instant::now() + PROPOSAL_TTL,
        cancel: CancellationToken::new(),
        claimed: false,
    };
    let cancelled = proposal.cancel.clone();
    RUNTIME
        .lock()
        .unwrap()
        .proposals
        .insert("config-proposal".into(), proposal);
    save(
        &path,
        update(BTreeMap::from([(
            "token".into(),
            Some("replacement".into()),
        )])),
    )
    .unwrap();
    assert!(s.cancel.is_cancelled());
    assert!(cancelled.is_cancelled());
    assert!(RUNTIME
        .lock()
        .unwrap()
        .proposals
        .get("config-proposal")
        .is_none());
    let store = read(&path).unwrap();
    assert!(store.servers[0].enabled); // Editing doesn't silently enable or disable.
    assert_eq!(store.servers[0].env.len(), 1); // Case-insensitive replacement.
    assert_eq!(
        crate::secret_protection::unprotect_secret(&store.servers[0].env["token"]).unwrap(),
        "replacement"
    );
    save(&path, update(BTreeMap::from([("TOKEN".into(), None)]))).unwrap();
    assert!(read(&path).unwrap().servers[0].env.is_empty());
    save(
        &path,
        update(BTreeMap::from([("EMPTY".into(), Some(String::new()))])),
    )
    .unwrap();
    let (_, _, env, _) = connection(&path, &id, "empty-request").unwrap();
    assert_eq!(env["EMPTY"], ""); // Explicit empty is distinct from omitted/remove.
    change(&path, &id, Some(false)).unwrap();
    assert!(RUNTIME
        .lock()
        .unwrap()
        .sessions
        .values()
        .all(|s| s.server_id != id));
    change(&path, &id, None).unwrap();
    assert!(read(&path).unwrap().servers.is_empty());
    assert!(!RUNTIME.lock().unwrap().configs.contains_key(&id));
    assert!(connection(&path, &id, "deleted-request").is_err());
    assert_eq!(
        save(
            &path,
            update(BTreeMap::from([
                ("A".into(), Some("x".into())),
                ("a".into(), None)
            ]))
        )
        .err(),
        Some("MCP_ENV_DUPLICATE")
    );

    // A different/future file must survive every write operation unchanged.
    for (bytes, error) in [
        ("{broken", "MCP_CONFIG_CORRUPT"),
        (
            "{\"version\":99,\"future\":true}",
            "MCP_CONFIG_VERSION_UNSUPPORTED",
        ),
    ] {
        fs::write(&path, bytes).unwrap();
        assert_eq!(read(&path).err(), Some(error));
        assert_eq!(save(&path, update(BTreeMap::new())).err(), Some(error));
        assert_eq!(change(&path, &id, Some(false)).err(), Some(error));
        assert_eq!(change(&path, &id, None).err(), Some(error));
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
    }
    // Anonymous fixtures are retained; no recursive cleanup of paths is performed.
}

pub(crate) async fn verify_http_persistence(url: &str) {
    let root = std::env::temp_dir().join(format!(
        "guanmo-mcp-http-config-{}-{}",
        std::process::id(),
        new_id("test")
    ));
    let path = root.join("mcp-servers.json");
    let stdio = super::super::tests::fixture("modern");
    save(
        &path,
        SaveServer {
            config: ServerConfig::Stdio(stdio.clone()),
            name: "Old stdio".into(),
            env_changes: BTreeMap::from([("TOKEN".into(), Some("anonymous-retained".into()))]),
        },
    )
    .unwrap();
    let ciphertext = read(&path).unwrap().servers[0].env["TOKEN"].clone();
    let update = |url: &str| SaveServer {
        config: ServerConfig::Http(HttpConfig {
            transport: HttpTransport::Http,
            server_id: "persistent-http".into(),
            url: url.into(),
        }),
        name: "Anonymous HTTP".into(),
        env_changes: BTreeMap::new(),
    };
    save(&path, update(&url.replacen("http:", "HTTP:", 1))).unwrap();
    let bytes = fs::read(&path).unwrap();
    let raw: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(raw["version"], 1);
    assert!(raw["servers"][0]["config"].get("transport").is_none());
    assert_eq!(raw["servers"][1]["config"]["transport"], "http");
    assert_eq!(
        connection(&path, "persistent-http", "disabled-http").err(),
        Some("MCP_SERVER_DISABLED")
    );
    assert!(RUNTIME.lock().unwrap().sessions.is_empty());
    let mut invalid = update(url);
    invalid
        .env_changes
        .insert("TOKEN".into(), Some("anonymous".into()));
    assert_eq!(save(&path, invalid).err(), Some("MCP_CONFIG_INVALID"));
    let mut switched = update(url);
    if let ServerConfig::Http(c) = &mut switched.config {
        c.server_id = stdio.server_id.clone();
    }
    assert_eq!(
        save(&path, switched).err(),
        Some("MCP_TRANSPORT_CHANGE_UNSUPPORTED")
    );
    for bad in [
        "https://user:secret@example.com/mcp",
        "https://example.com/mcp?token=secret",
    ] {
        assert_eq!(save(&path, update(bad)).err(), Some("MCP_HTTP_URL_INVALID"));
    }
    assert_eq!(fs::read(&path).unwrap(), bytes);
    for invalid in [
        serde_json::json!({"transport":"http","serverId":"persistent-http","url":url,"headers":{}}),
        serde_json::json!({"transport":"unknown","serverId":"persistent-http","url":url}),
        serde_json::json!({"transport":"http","serverId":"persistent-http","url":url,"executable":"ignored.exe"}),
    ] {
        let mut malformed = raw.clone();
        malformed["servers"][1]["config"] = invalid;
        let malformed = serde_json::to_vec(&malformed).unwrap();
        fs::write(&path, &malformed).unwrap();
        assert_eq!(save(&path, update(url)).err(), Some("MCP_CONFIG_CORRUPT"));
        assert_eq!(fs::read(&path).unwrap(), malformed);
    }
    let mut with_env = raw;
    with_env["servers"][1]["env"] = serde_json::json!({"TOKEN":[1]});
    let with_env = serde_json::to_vec(&with_env).unwrap();
    fs::write(&path, &with_env).unwrap();
    assert_eq!(save(&path, update(url)).err(), Some("MCP_CONFIG_CORRUPT"));
    assert_eq!(fs::read(&path).unwrap(), with_env);
    fs::write(&path, bytes).unwrap(); // Restore only this anonymous test fixture.
    change(&path, "persistent-http", Some(true)).unwrap();
    assert!(RUNTIME.lock().unwrap().sessions.is_empty()); // No network or auto-connect.
    let (s, config, env, _) = connection(&path, "persistent-http", "persistent-request").unwrap();
    assert!(env.is_empty());
    assert_eq!(s.target, url);
    let s = config.start(s, &env, None).await.unwrap();
    let catalog = list_catalog(&s).await.unwrap();
    let listed = serde_json::to_value(views(read(&path).unwrap()).unwrap()).unwrap();
    assert_eq!(listed[1]["status"], "connected");
    assert_eq!(listed[1]["connectionId"], s.id);
    assert_eq!(listed[1]["config"]["url"], url);
    let p =
        super::super::tests::prepare(&s, &catalog, "echo", serde_json::json!({"persisted": true}));
    let output = super::super::tests::text(execute(&claim(&p).unwrap()).await.unwrap());
    assert_eq!(output["args"]["persisted"], true);
    let pending = super::super::tests::prepare(&s, &catalog, "echo", serde_json::json!({}));
    save(&path, update(&format!("{url}/edited"))).unwrap();
    assert!(s.cancel.is_cancelled());
    assert!(claim(&pending).is_err());
    let (s, _, _, _) = connection(&path, "persistent-http", "before-disable").unwrap();
    change(&path, "persistent-http", Some(false)).unwrap();
    assert!(s.cancel.is_cancelled());
    change(&path, "persistent-http", Some(true)).unwrap();
    let (s, _, _, _) = connection(&path, "persistent-http", "before-delete").unwrap();
    change(&path, "persistent-http", None).unwrap();
    assert!(s.cancel.is_cancelled());
    assert!(connection(&path, "persistent-http", "after-delete").is_err());
    let store = read(&path).unwrap();
    assert_eq!(store.servers.len(), 1);
    assert!(store.servers[0].config == ServerConfig::Stdio(stdio));
    assert_eq!(store.servers[0].env["TOKEN"], ciphertext);
}

pub(crate) async fn verify_environment_and_revoke() {
    let root = std::env::temp_dir().join(format!(
        "guanmo-mcp-env-{}-{}",
        std::process::id(),
        new_id("test")
    ));
    let path = root.join("mcp-servers.json");
    let config = super::super::tests::fixture("modern");
    let id = config.server_id.clone();
    save(
        &path,
        SaveServer {
            config: ServerConfig::Stdio(config),
            name: "Anonymous env".into(),
            env_changes: BTreeMap::from([(
                "MCP_CONFIGURED_TOKEN".into(),
                Some("anonymous-configured-token".into()),
            )]),
        },
    )
    .unwrap();
    change(&path, &id, Some(true)).unwrap();
    let (s, config, env, _) = connection(&path, &id, "env-request").unwrap();
    let s = config.start(s, &env, None).await.unwrap();
    let catalog = list_catalog(&s).await.unwrap();
    let request = || PrepareCall {
        connection_id: s.id.clone(),
        catalog_revision: catalog.catalog_revision.clone(),
        tool_name: "echo".into(),
        arguments: serde_json::json!({}),
    };
    let proposal = mcp_prepare_call(request()).unwrap();
    let output = execute(&claim(&proposal.proposal_id).unwrap())
        .await
        .unwrap();
    let value: Value =
        serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(value["configuredToken"], true);
    assert_eq!(value["injected"], false);
    assert_eq!(value["nodeOptions"], false);
    let pending = mcp_prepare_call(request()).unwrap();
    let p = claim(&pending.proposal_id).unwrap();
    change(&path, &id, Some(false)).unwrap();
    assert!(execute(&p).await.is_err());
    assert!(s.cancel.is_cancelled());
    #[cfg(windows)]
    tokio::time::timeout(Duration::from_secs(5), async {
        while super::super::tests::alive(value["pid"].as_u64().unwrap() as u32)
            || super::super::tests::alive(value["descendantPid"].as_u64().unwrap() as u32)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("disabled MCP process tree leaked");
    change(&path, &id, None).unwrap();
}
