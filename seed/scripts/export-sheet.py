#!/usr/bin/env python3
"""Export every tab of the "Asia 2027" Google Sheet to seed/data/<tab-slug>.json (READ-ONLY).

Usage:
  python3 seed/scripts/export-sheet.py                 # fetch with the gws CLI, then export
  python3 seed/scripts/export-sheet.py grid.json OUT   # export from a saved spreadsheets.get grid dump

Needs an authenticated `gws` CLI. Only calls spreadsheets.get; nothing is written to the sheet.
Afterwards run build-geocode-hints.py to refresh geocode-hints.json.
"""
import subprocess, tempfile
import json, re, sys, datetime, os

FIELDS = ("properties(title,timeZone,locale),sheets(properties(sheetId,title,index),data(startRow,startColumn,"
          "rowData(values(formattedValue,effectiveValue,userEnteredValue,hyperlink,textFormatRuns(startIndex,format(link)),"
          "note,userEnteredFormat(textFormat(link),numberFormat))),rowMetadata(hiddenByUser,hiddenByFilter)),rowGroups,merges)")
# The sheet stays private: its id comes from the environment, never the repo.
SSID = os.environ.get("ASIA_SHEET_ID", "<sheet-id>")
if len(sys.argv) < 3:
    if SSID == "<sheet-id>":
        sys.exit("set ASIA_SHEET_ID to the Google Sheet id")
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, '..', 'data')
    params = json.dumps({"spreadsheetId": SSID, "includeGridData": True, "fields": FIELDS})
    res = subprocess.run(['gws', 'sheets', 'spreadsheets', 'get', '--params', params], capture_output=True, text=True, check=True)
    tmp = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False); tmp.write(res.stdout); tmp.close()
    sys.argv = [sys.argv[0], tmp.name, out_dir]
SRC=sys.argv[1]; OUT=sys.argv[2]
d=json.load(open(SRC))
now=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
EPOCH=datetime.date(1899,12,30)
BLANKS={"","—"}

def slug(t): return re.sub(r'[^a-z0-9]+','-',t.lower()).strip('-')
def col_letter(i):
    s=''; i+=1
    while i: i,r=divmod(i-1,26); s=chr(65+r)+s
    return s

def cell_links(c):
    """Return [{text,url}] for every linked run in the cell (in order)."""
    text=c.get('formattedValue','') or ''
    out=[]
    runs=c.get('textFormatRuns') or []
    for k,tr in enumerate(runs):
        u=(tr.get('format') or {}).get('link',{}).get('uri')
        if not u: continue
        s=tr.get('startIndex',0); e=runs[k+1].get('startIndex',len(text)) if k+1<len(runs) else len(text)
        seg=text[s:e].strip()
        if out and out[-1]['url']==u and s==out[-1]['_e']:
            out[-1]['text']=(out[-1]['text']+text[s:e]).strip(); out[-1]['_e']=e; continue
        out.append({'text':seg,'url':u,'_e':e})
    whole=(c.get('userEnteredFormat') or {}).get('textFormat',{}).get('link',{}).get('uri') or c.get('hyperlink')
    if whole and not any(o['url']==whole for o in out):
        out.insert(0,{'text':text.strip(),'url':whole,'_e':len(text)})
    for o in out: o.pop('_e',None)
    return out

def typed(c):
    fv=c.get('formattedValue')
    if fv is None or fv.strip() in BLANKS: return None
    ev=c.get('effectiveValue') or {}
    nf=((c.get('userEnteredFormat') or {}).get('numberFormat') or {}).get('type')
    if 'numberValue' in ev:
        n=ev['numberValue']
        if nf in ('DATE','DATE_TIME'):
            dt=datetime.datetime.combine(EPOCH,datetime.time())+datetime.timedelta(days=n)
            return dt.date().isoformat() if nf=='DATE' else dt.isoformat()
        return int(n) if float(n).is_integer() else n
    if 'boolValue' in ev: return ev['boolValue']
    return fv

def grid(sh):
    rows=sh['data'][0].get('rowData',[])
    ncol=max([len(r.get('values',[])) for r in rows]+[0])
    cells=[[ (r.get('values',[])+[{}]*ncol)[:ncol] for r in [row] ][0] for row in rows]
    return cells, ncol

def raw_dump(cells):
    vals=[[c.get('formattedValue','') for c in r] for r in cells]
    # trim trailing empty cols per row and trailing empty rows
    vals=[ (lambda v: v[:max([i+1 for i,x in enumerate(v) if x!='']+[0])])(r) for r in vals]
    while vals and not vals[-1]: vals.pop()
    links={}; formulas={}
    for i,r in enumerate(cells):
        for j,c in enumerate(r):
            a=f"{col_letter(j)}{i+1}"
            L=cell_links(c)
            if L: links[a]=L
            f=(c.get('userEnteredValue') or {}).get('formulaValue')
            if f: formulas[a]=f
    return {'values':vals,'links':links,'formulas':formulas}

def table(cells, header_row=0, col_range=None, first_data_row=1):
    hdr=cells[header_row]
    idxs=[j for j in range(len(hdr)) if (hdr[j].get('formattedValue') or '').strip()]
    if col_range: idxs=[j for j in idxs if col_range[0]<=j<=col_range[1]]
    headers=[hdr[j]['formattedValue'].strip() for j in idxs]
    linkcols=set()
    for r in cells[first_data_row:]:
        for j in idxs:
            if cell_links(r[j]): linkcols.add(j)
    out=[]
    for i in range(first_data_row,len(cells)):
        r=cells[i]
        if all(typed(r[j]) is None and not cell_links(r[j]) for j in idxs): continue
        o={'_row':i+1}
        for j,h in zip(idxs,headers):
            o[h]=typed(r[j])
            if j in linkcols:
                L=cell_links(r[j])
                o[h+'_url']=L[0]['url'] if L else None
                o[h+'_links']=L
        out.append(o)
    cols=[{'letter':col_letter(j),'header':h,'has_links':j in linkcols} for j,h in zip(idxs,headers)]
    return headers, cols, out

def parse_day(label):
    if not label: return None
    m=re.match(r'^\s*(\d+)\s*·\s*([^·]+?)\s*(?:·\s*(.+?))?\s*$',label)
    if m: return {'number':int(m.group(1)),'city':m.group(2).strip(),'title':(m.group(3) or '').strip() or None,'is_backup':False}
    return {'number':None,'city':None,'title':label,'is_backup':True}

os.makedirs(OUT,exist_ok=True)
index=[]
for sh in d['sheets']:
    p=sh['properties']; t=p['title']; sl=slug(t)
    cells,ncol=grid(sh)
    doc={'source':{'spreadsheetId':SSID,'spreadsheetTitle':d['properties']['title'],'spreadsheetTimeZone':d['properties'].get('timeZone'),
                   'tab':t,'sheetId':p['sheetId'],'tabIndex':p['index'],'exportedAt':now,'exporter':'gws sheets spreadsheets get (includeGridData)'}}
    if t=='Random Notes':
        lines=[]
        for i,r in enumerate(cells):
            vs=[c.get('formattedValue','') for c in r]
            if not any(v.strip() for v in vs): continue
            L=[]
            for c in r: L+=cell_links(c)
            nonempty=[v for v in vs if v.strip()]
            lines.append({'_row':i+1,'text':nonempty[0],'extra':nonempty[1:],'url':L[0]['url'] if L else None,'links':L})
        doc['headers']=None
        doc['columns']=None
        doc['rows']=lines
    elif t=='Itinerary':
        headers,cols,rows=table(cells,col_range=(0,7))
        for r in rows: r['_day']=parse_day(r.get('Day'))
        doc['headers']=headers; doc['columns']=cols; doc['rows']=rows
        # summary block J:K (cols 9,10)
        summ=[]
        for i in range(1,len(cells)):
            j=cells[i][9] if len(cells[i])>9 else {}; k=cells[i][10] if len(cells[i])>10 else {}
            jl=(j.get('formattedValue') or '').strip(); kv=typed(k)
            if not jl and kv is None: continue
            kind='day_total' if (k.get('userEnteredValue') or {}).get('formulaValue') else ('capacity' if jl.lower().startswith('capacity') else 'note')
            summ.append({'_row':i+1,'label':jl,'hrs':kv,'hrs_formatted':k.get('formattedValue'),'formula':(k.get('userEnteredValue') or {}).get('formulaValue'),'kind':kind,'_day':parse_day(jl) if kind=='day_total' else None})
        doc['summary']={'range':'J1:K'+str(max([s['_row'] for s in summ]+[1])),'headers':[(cells[0][9].get('formattedValue') or ''),(cells[0][10].get('formattedValue') or '')],'rows':summ,
                        'note':'Not itinerary rows. Per-day SUMIF totals of column E (Hrs) keyed by the Day label, a capacity line, and a free-text assumptions note.'}
    else:
        headers,cols,rows=table(cells)
        doc['headers']=headers; doc['columns']=cols; doc['rows']=rows
    doc['raw']=raw_dump(cells)
    fn=os.path.join(OUT,sl+'.json')
    json.dump(doc,open(fn,'w'),ensure_ascii=False,indent=2)
    nlinks=sum(len(v) for v in doc['raw']['links'].values())
    index.append({'tab':t,'sheetId':p['sheetId'],'file':sl+'.json','rows':len(doc['rows']),'links':nlinks})
    print(f"{t:35s} -> {sl}.json rows={len(doc['rows'])} links={nlinks} formulas={len(doc['raw']['formulas'])}")
json.dump({'spreadsheetId':SSID,'title':d['properties']['title'],'exportedAt':now,'tabs':index},open(os.path.join(OUT,'_index.json'),'w'),ensure_ascii=False,indent=2)
