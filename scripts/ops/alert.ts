import { sendOperatorAlert } from "./lib"

const unit = process.argv[2] || "unknown"
await sendOperatorAlert(`MoeMail systemd unit failed: ${unit}`, { unit })
