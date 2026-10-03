import Foundation

final class MockGatewayProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, JSONObject))!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, value) = try Self.handler(request)
            let response = HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:["Content-Type":"application/json","ETag":"test-tag"])!
            client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self,didLoad:try JSONSerialization.data(withJSONObject:value))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self,didFailWithError:error) }
    }
    override func stopLoading() {}
}
@main struct NativeStoreTests {
    @MainActor static func main() async throws {
        for invalid in ["", "ShoWin2333", "@user", "+8613800000000", "123:token", "0", "9007199254740992"] {
            precondition(TelegramFormValidation.ownerError(invalid) != nil)
        }
        precondition(TelegramFormValidation.ownerError(" 123456789 ") == nil)
        print("PASS: Telegram owner validation rejects usernames, phones and tokens before submission")
        for invalid in ["", "@user", "+123456789", "0", "18446744073709551616", "123:token"] {
            precondition(DiscordFormValidation.ownerError(invalid) != nil)
        }
        precondition(DiscordFormValidation.ownerError(" 234567890123456789 ") == nil)
        precondition(DiscordFormValidation.ownerError("18446744073709551615") == nil)
        print("PASS: Discord owner validation preserves 64-bit IDs and rejects invalid forms")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockGatewayProtocol.self]
        let session = URLSession(configuration:config)
        defer { session.invalidateAndCancel() }
        let original: JSONObject = ["id":"one","label":"Original","cwd":"/workspace","backend":"codex","projectId":"p","projectSecretEnv":"SECRET","senderPhoneNumber":"+15551234567","assignedPhoneNumber":"+15557654321","cursorApiKeyEnv":"CUSTOM_CURSOR_KEY"]
        var serverRoute = original
        var revision = 0
        var posted: JSONObject = [:]
        var failSave = false
        MockGatewayProtocol.handler = { request in
            if request.httpMethod == "POST" {
                precondition(request.value(forHTTPHeaderField:"Origin") == "http://127.0.0.1:8787")
                precondition(request.value(forHTTPHeaderField:"x-agent-token") == "private-token")
                var data = request.httpBody ?? Data()
                if let stream = request.httpBodyStream {
                    stream.open(); defer { stream.close() }
                    var bytes = [UInt8](repeating:0,count:4096)
                    while stream.hasBytesAvailable {
                        let count = stream.read(&bytes,maxLength:bytes.count)
                        if count <= 0 { break }; data.append(bytes,count:count)
                    }
                }
                posted = try JSONSerialization.jsonObject(with:data) as! JSONObject
                if failSave || posted["revision"] as? Int != revision { return (409,["error":"Conflict"]) }
                serverRoute = posted.object("route"); revision += 1
                return (200,["ok":true])
            }
            return (200,["revision":revision,"csrf":"private-token","config":["routes":[serverRoute]],"routes":[["id":"one","channels":[["id":"imessage","kind":"imessage","activity":[["sequence":1,"at":1234,"stage":"received","text":"hello"]]]]]]])
        }
        let store = GatewayStore(url:URL(string:"http://127.0.0.1:8787/")!,session:session)
        await store.refresh()
        precondition(store.connected && store.drafts.count == 1)
        let draft = store.drafts[0]
        draft.set("label","Unsaved")
        await store.refresh()
        precondition(store.drafts[0] === draft && draft.name == "Unsaved")
        precondition(store.activities("one").first?.value.text("text") == "hello")
        print("PASS: polling updates activities without replacing unsaved drafts")
        draft.secrets["one"] = "new-secret"
        await store.save(draft)
        precondition(!draft.dirty && draft.secrets.isEmpty)
        precondition(posted.object("route").text("cursorApiKeyEnv") == "CUSTOM_CURSOR_KEY")
        precondition(posted.object("route")["channels"] == nil)
        precondition(posted.object("photon").text("one") == "new-secret")
        print("PASS: native saves preserve legacy identity and optional fields; Origin and CSRF are sent")
        failSave = true
        draft.set("label","Keep this draft"); draft.secrets["one"] = "retain-on-failure"
        await store.save(draft)
        precondition(draft.dirty && draft.secrets["one"] == "retain-on-failure")
        precondition(store.notice.contains("其他窗口"))
        print("PASS: revision conflicts retain unsaved edits and credentials")
        failSave = false
        revision += 1
        await store.refresh()
        await store.save(draft)
        precondition(posted["revision"] as? Int == 1 && draft.dirty)
        print("PASS: polling does not silently overwrite the editor revision")
        let channels = draft.channels
        draft.setChannels(channels + [["id":"wechat","kind":"weixin","accountId":"owner"]])
        precondition(draft.channels[0].text("id") == "imessage" && draft.value.text("projectId") == "p")
        draft.setChannels([])
        precondition(draft.value["enabled"] as? Bool == false)
        print("PASS: channel migration preserves legacy identity; removing all channels disables route")
        MockGatewayProtocol.handler = { request in
            precondition(request.value(forHTTPHeaderField:"If-None-Match") == "test-tag")
            return (304,[:])
        }
        await store.refresh()
        precondition(store.connected && store.drafts[0] === draft && draft.dirty)
        precondition(store.activities("one").first?.value.text("text") == "hello")
        print("PASS: unchanged responses preserve state and unsaved drafts without decoding a new body")

        let botA = "123456789012345678", botB = "345678901234567890", owner = "234567890123456789"
        let firstAgent: JSONObject = ["id":"alice","label":"Alice","channels":[["id":"discord-a","kind":"discord","botId":botA,"ownerUserId":owner]]]
        let secondAgent: JSONObject = ["id":"jane","label":"Jane","channels":[["id":"discord-b","kind":"discord","botId":"","ownerUserId":""]]]
        var savedAccounts: [JSONObject] = [["botId":botA,"username":"Alice","ownerUserId":owner]]
        var accountRevision = 0
        MockGatewayProtocol.handler = { request in
            if request.httpMethod == "POST" {
                precondition(request.url?.path == "/api/discord/save")
                savedAccounts.append(["botId":botB,"username":"Jane","ownerUserId":owner])
                accountRevision += 1
                return (200,["ok":true])
            }
            return (200,["revision":accountRevision,"csrf":"synthetic-csrf","config":["routes":[firstAgent,secondAgent]],"discordAccounts":savedAccounts,
                         "telegramAccounts":[["botId":"12345","username":"telegram_only","ownerUserId":"123456"]]])
        }
        let accountStore = GatewayStore(url:URL(string:"http://127.0.0.1:8787/")!,session:session)
        await accountStore.refresh()
        let secondDraft = accountStore.drafts[1]
        secondDraft.set("label","Jane unsaved")
        precondition(ChannelAccountOption.options("discord",state:accountStore.state,draft:secondDraft,channelID:"discord-b").map(\.id) == [botA])
        let saved = await accountStore.saveChannelAccount("api/discord/save",["token":"synthetic-second-bot-token","ownerUserId":owner])
        precondition(saved && accountStore.drafts[1] === secondDraft && secondDraft.dirty && secondDraft.name == "Jane unsaved")
        let options = ChannelAccountOption.options("discord",state:accountStore.state,draft:secondDraft,channelID:"discord-b")
        precondition(options.map(\.id) == [botA,botB])
        precondition(options[0].label == "Alice · " + botA && options[0].boundTo == "Alice")
        precondition(options[1].label == "Jane · " + botB && options[1].boundTo == nil)
        secondDraft.setChannels([["id":"discord-b","kind":"discord","botId":botB,"ownerUserId":owner]])
        precondition(ChannelAccountOption.options("discord",state:accountStore.state,draft:secondDraft,channelID:"discord-b")[1].boundTo == nil)
        precondition(ChannelAccountOption.options("telegram",state:accountStore.state,draft:secondDraft,channelID:"discord-b").map(\.id) == ["12345"])
        var unboundState = accountStore.state
        unboundState["config"] = ["routes":[secondAgent]]
        precondition(ChannelAccountOption.options("discord",state:unboundState,draft:secondDraft,channelID:"discord-b").allSatisfy { $0.boundTo == nil })
        print("PASS: adding a second Discord bot refreshes both named picker rows, preserves unsaved Agent edits and scopes bindings by bot ID and transport")
    }
}
