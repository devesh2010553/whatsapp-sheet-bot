const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { google } = require("googleapis");
const vehicles = require("./vehicles.json");
const express = require("express");
const fs = require("fs");

const app = express();
app.get("/", (req,res)=>res.send("Fleet Bot Running"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Webserver on ${PORT}`));

// --- Google Auth ---
const auth = new google.auth.GoogleAuth({
  keyFile: "service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

// --- WhatsApp Client with Persistent Session ---
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "fleet-bot" }),
  puppeteer: { headless: true }
});

client.on("qr", qr => qrcode.generate(qr, { small: true }));
client.on("ready", () => console.log("WhatsApp Bot Ready"));

// --- Helpers ---
function cleanVehicle(v) { return v.replace(/\s+/g, "").toUpperCase(); }
function parseTime(t){
    t=t.toLowerCase(); 
    const pm=t.includes("pm"); 
    t=t.replace(/am|pm/,""); 
    let [h,m]=t.split(":").map(Number);
    if(pm && h!==12) h+=12;
    return [h,m];
}
function hoursBetween(start,end){
    let s=start[0]*60+start[1];
    let e=end[0]*60+end[1];
    if(e<s) e+=1440;
    return (e-s)/60;
}
function calculateOT(start,end){
    let hrs = hoursBetween(start,end);
    let extra = hrs-12;
    if(extra<=0) return 0;
    if(extra>0.5) return Math.ceil(extra);
    return 0;
}
function isNight(start,end){ return start[0]<5 || end[0]>=22; }
function getRemarks(start,end){
    const night=isNight(start,end);
    const sunday=new Date().getDay()===0;
    if(night && sunday) return "Night/Sunday";
    if(night) return "Night";
    if(sunday) return "Sunday";
    return "";
}

// --- Update Sheet ---
async function updateSheet(vehicle,openKM,closeKM,startTimeStr,endTimeStr){
    const config=vehicles[vehicle]; 
    if(!config) return;

    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const today = new Date();
    const row = today.getDate() + 7; // adjust if your sheet has headers

    // --- Fetch existing opening if needed
    const read = await sheets.spreadsheets.values.get({
        spreadsheetId: config.file_id,
        range: `${config.sheet}!C${row}:I${row}`
    });

    const oldOpenKM = read.data.values?.[0]?.[0] || openKM;
    const oldStartTime = read.data.values?.[0]?.[3] || startTimeStr;

    const startTime=parseTime(startTimeStr);
    const endTime=parseTime(endTimeStr || startTimeStr);

    const total = (closeKM ? closeKM - oldOpenKM : 0);
    const ot = closeKM ? calculateOT(startTime,endTime) : "";
    const remarks = closeKM ? getRemarks(startTime,endTime) : "";

    const values=[[ oldOpenKM, closeKM || "", total, oldStartTime, endTimeStr || "", ot, remarks ]];

    await sheets.spreadsheets.values.update({
        spreadsheetId: config.file_id,
        range: `${config.sheet}!C${row}:I${row}`,
        valueInputOption: "USER_ENTERED",
        resource: { values }
    });
}

// --- Duplicate prevention ---
const processedMessages = new Set();

// --- Message Handler ---
client.on("message", async msg => {
    if(!msg.from.includes("g.us")) return; // only groups
    if(!msg.body.includes("Cab number")) return;
    if(processedMessages.has(msg.id)) return; // prevent duplicates
    processedMessages.add(msg.id);

    const text = msg.body;
    let vehicle=text.match(/Cab number\s*:\s*(.*)/i)?.[1];
    if(vehicle) vehicle=cleanVehicle(vehicle);

    const openKM=parseInt(text.match(/Reporting KM\s*:\s*(\d+)/i)?.[1]);
    const openTime=text.match(/Reporting Time\s*:\s*(.*)/i)?.[1];
    const closeKM=parseInt(text.match(/Closing KM\s*:\s*(\d+)/i)?.[1]);
    const closeTime=text.match(/Closing Time\s*:\s*(.*)/i)?.[1];

    if(!vehicles[vehicle]) return;

    await updateSheet(vehicle, openKM, closeKM, openTime, closeTime);

    msg.reply(closeKM ? "Closing Entry Saved ✅" : "Opening Entry Saved ✅");
});

client.initialize();