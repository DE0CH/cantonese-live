//! Idempotent Cloudflare Access setup for cantonese.deyaochen.com. Two policies: Deyao's email (one-time PIN) and
//! the `cantonese-live-ci` service token, which the relay workflow's live test uses. The iOS app transcribes on the
//! phone and never calls the relay, so the old `cantonese-ios` service token is deleted if it still exists.
//!
//! Env: CLOUDFLARE_API (Access apps, policies and service tokens).
//! Usage: cloudflare-access [--token-out PATH]
//!   A service token's secret is shown only when it is made: if `cantonese-live-ci` doesn't exist yet it is made and
//!   its {"client_id","client_secret"} written to PATH (0600), never printed; set them as the repo's
//!   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET Actions secrets.
use serde_json::{Value, json};
use std::{env, fs, io::Write, os::unix::fs::OpenOptionsExt};

const ACCOUNT_ID: &str = "ee3b4deef856baf11e1a67b242438325";
const HOST: &str = "cantonese.deyaochen.com";
const OWNER_EMAIL: &str = "chendeyao000@gmail.com";
const CI_TOKEN: &str = "cantonese-live-ci";
const OLD_TOKENS: &[&str] = &["cantonese-ios"];

type R<T> = Result<T, Box<dyn std::error::Error>>;

struct Api {
    base: String,
    auth: String,
}

impl Api {
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> R<Value> {
        let url = format!("{}{}", self.base, path);
        let mut res = match (method, body) {
            ("GET", _) => ureq::get(&url).header("Authorization", &self.auth).call(),
            ("DELETE", _) => ureq::delete(&url).header("Authorization", &self.auth).call(),
            ("POST", Some(b)) => ureq::post(&url).header("Authorization", &self.auth).send_json(b),
            ("PUT", Some(b)) => ureq::put(&url).header("Authorization", &self.auth).send_json(b),
            _ => unreachable!(),
        }
        .map_err(|e| format!("{method} {path}: {e}"))?;
        let v: Value = res.body_mut().read_json()?;
        if v["success"] != json!(true) {
            return Err(format!("{method} {path}: {}", v["errors"]).into());
        }
        Ok(v["result"].clone())
    }
    fn ids_named(&self, path: &str, key: &str, value: &str) -> R<Vec<String>> {
        let list = self.call("GET", path, None)?;
        Ok(list
            .as_array()
            .into_iter()
            .flatten()
            .filter(|x| x[key] == value)
            .filter_map(|x| x["id"].as_str().map(String::from))
            .collect())
    }
}

fn main() -> R<()> {
    let args: Vec<String> = env::args().collect();
    let token_out = args.iter().position(|a| a == "--token-out").and_then(|i| args.get(i + 1)).cloned();
    let api = Api {
        base: format!("https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/access"),
        auth: format!("Bearer {}", env::var("CLOUDFLARE_API").map_err(|_| "CLOUDFLARE_API is not set")?),
    };

    let app_body = json!({"name": "Cantonese live", "domain": HOST, "type": "self_hosted",
                          "session_duration": "720h", "app_launcher_visible": false});
    let app = match api.ids_named("/apps", "domain", HOST)?.first() {
        Some(id) => {
            api.call("PUT", &format!("/apps/{id}"), Some(app_body))?;
            id.clone()
        }
        None => api.call("POST", "/apps", Some(app_body))?["id"].as_str().ok_or("no app id")?.to_string(),
    };

    let ci = match api.ids_named("/service_tokens", "name", CI_TOKEN)?.first() {
        Some(id) => id.clone(),
        None => {
            let out = token_out.ok_or(format!("{CI_TOKEN} doesn't exist yet: pass --token-out PATH for its secret"))?;
            let t = api.call("POST", "/service_tokens", Some(json!({"name": CI_TOKEN, "duration": "forever"})))?;
            let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&out)?;
            f.write_all(json!({"client_id": t["client_id"], "client_secret": t["client_secret"]}).to_string().as_bytes())?;
            println!("made service token {CI_TOKEN}; its secret is in {out}");
            t["id"].as_str().ok_or("no token id")?.to_string()
        }
    };

    let pol = format!("/apps/{app}/policies");
    let old = api.call("GET", &pol, None)?;
    for p in old.as_array().into_iter().flatten().filter_map(|p| p["id"].as_str()) {
        api.call("DELETE", &format!("{pol}/{p}"), None)?;
    }
    api.call("POST", &pol, Some(json!({"name": "owner", "decision": "allow", "precedence": 1,
                                        "include": [{"email": {"email": OWNER_EMAIL}}]})))?;
    api.call("POST", &pol, Some(json!({"name": "ci", "decision": "non_identity", "precedence": 2,
                                        "include": [{"service_token": {"token_id": ci}}]})))?;
    println!("Access app {HOST}: owner email, service token {CI_TOKEN}");

    for name in OLD_TOKENS {
        for t in api.ids_named("/service_tokens", "name", name)? {
            api.call("DELETE", &format!("/service_tokens/{t}"), None)?;
            println!("deleted service token {name}");
        }
    }
    Ok(())
}
