use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
use rmcp::{
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::{async_rw::AsyncRwTransport, Transport},
    RoleClient,
};
use std::{future::Future, io, process::Stdio, time::Duration};
use tokio::process::{ChildStdin, ChildStdout, Command};

use super::StdioConfig;

/// Own the process tree together with the protocol transport. Dropping an unfinished
/// initialize future must also kill the child, before a RunningService exists.
pub(super) struct StdioTransport {
    io: AsyncRwTransport<RoleClient, ChildStdout, ChildStdin>,
    child: Box<dyn ChildWrapper>,
}

impl StdioTransport {
    pub(super) fn spawn(
        config: &StdioConfig,
        env: &std::collections::BTreeMap<String, String>,
    ) -> io::Result<Self> {
        let mut cmd = Command::new(&config.executable);
        cmd.args(&config.args)
            .current_dir(&config.cwd)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Do not inherit provider tokens, NODE_OPTIONS, Python startup hooks, etc.
        for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                cmd.env(name, value);
            }
        }
        cmd.envs(env);
        let mut wrapped = CommandWrap::from(cmd);
        wrapped.wrap(KillOnDrop);
        #[cfg(windows)]
        {
            use process_wrap::tokio::{CreationFlags, JobObject};
            let mut flags = CreationFlags(Default::default());
            flags.0 .0 = 0x0800_0000; // CREATE_NO_WINDOW
            wrapped.wrap(flags);
            wrapped.wrap(JobObject);
        }
        #[cfg(unix)]
        wrapped.wrap(process_wrap::tokio::ProcessGroup::leader());
        let mut child = wrapped.spawn()?;
        let stdout = child
            .inner_mut()
            .stdout()
            .take()
            .ok_or_else(|| io::Error::other("MCP stdout"))?;
        let stdin = child
            .inner_mut()
            .stdin()
            .take()
            .ok_or_else(|| io::Error::other("MCP stdin"))?;
        Ok(Self {
            io: AsyncRwTransport::new(stdout, stdin).with_max_line_length(1024 * 1024),
            child,
        })
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

impl Transport<RoleClient> for StdioTransport {
    type Error = io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = io::Result<()>> + Send + 'static {
        self.io.send(item)
    }

    fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.io.receive()
    }

    async fn close(&mut self) -> io::Result<()> {
        // Kill the job/group even if the direct child has already exited.
        let result =
            tokio::time::timeout(Duration::from_secs(3), Box::into_pin(self.child.kill())).await;
        let _ = self.io.close().await;
        match result {
            Ok(result) => result,
            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "MCP shutdown")),
        }
    }
}
