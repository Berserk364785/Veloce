import json
import pytest
from fastapi.testclient import TestClient
import main
from providers import content

@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv('APP_ORIGIN', raising=False)
    monkeypatch.delenv('KINOPOISK_API_KEY', raising=False)
    monkeypatch.delenv('KODIK_TOKEN', raising=False)
    main.rooms.clear(); main.limits.clear(); content.cache.clear()
    with TestClient(main.app) as client:
        yield client

def until(ws, kind):
    for _ in range(30):
        message=ws.receive_json()
        if message['type']==kind:
            return message
    raise AssertionError('No '+kind)

def test_rooms_chat_sync_roles_and_source_revision(client):
    ident=client.post('/api/rooms').json()['room_id']
    with client.websocket_connect('/ws/'+ident+'/Alice',headers={'origin':'http://testserver'}) as a:
        first=until(a,'init'); until(a,'members')
        with client.websocket_connect('/ws/'+ident+'/Bob',headers={'origin':'http://testserver'}) as b:
            second=until(b,'init'); until(b,'members'); until(a,'members')
            assert first['host']==first['self'] and len(second['members'])==2
            b.send_json({'type':'change_source','source':{'kind':'direct','url':'https://cdn.example/test.mp4'}})
            assert 'ведущий' in until(b,'error')['message']
            a.send_json({'type':'change_source','source':{'kind':'youtube','url':'https://youtu.be/aqz-KE-bpKQ'}})
            new=until(a,'change_source');until(b,'change_source');revision=new['playback']['source_revision']
            a.send_json({'type':'seek','time':42,'playing':True,'source_revision':revision})
            update=until(b,'seek');until(a,'seek');assert update['playback']['time']>=42
            b.send_json({'type':'chat','text':'<img src=x onerror=alert(1)> 💜'})
            assert until(a,'chat')['message']['text'].startswith('<img');until(b,'chat')
            a.send_json({'type':'reaction','emoji':'💜'});assert until(b,'reaction')['emoji']=='💜';until(a,'reaction')
            b.send_json({'type':'take_host'});assert until(a,'members')['host']==second['self'];until(b,'members');until(a,'state');until(b,'state')
            b.send_json({'type':'change_source','source':{'kind':'direct','url':'https://cdn.example/new.m3u8'}})
            changed=until(a,'change_source');until(b,'change_source');assert changed['source']['format']=='hls'
            # A stale heartbeat from the old source must not move the new video.
            b.send_json({'type':'state','time':999,'playing':True,'source_revision':revision})
            b.send_json({'type':'ping','client_time':1000});until(b,'pong')
            assert main.rooms[ident].current_time==0
        stopped=until(a,'state');assert stopped['playback']['playing'] is False
        assert until(a,'members')['host']==first['self']

def test_missing_credentials_and_headers(client):
    assert client.get('/api/movies/search?q=Matrix').status_code==503
    assert client.get('/api/anime/search?q=Naruto&provider=kodik').status_code==503
    assert client.get('/api/anime/search?q=x').status_code==422
    assert client.post('/api/rooms',headers={'origin':'https://evil.test'}).status_code==403
    assert 'Content-Security-Policy' in client.get('/').headers
    assert client.get('/api/config').json()['capabilities']['movies'] is False
    assert client.get('/.env').status_code==404

def test_bad_origin_and_isolation(client):
    ident=client.post('/api/rooms').json()['room_id']
    with pytest.raises(Exception):
        with client.websocket_connect('/ws/'+ident+'/Alice',headers={'origin':'https://evil.test'}):pass
    with client.websocket_connect('/ws/abcdefghijklmnopqrstuvwx/Alice',headers={'origin':'http://testserver'}) as ws:
        assert ws.receive_json()['type']=='expired'

@pytest.mark.parametrize('source',[
 {'kind':'direct','url':'javascript:alert(1)'},
 {'kind':'youtube','url':'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ'},
 {'kind':'direct','url':'https://127.0.0.1/a.mp4'},
 {'kind':'direct','url':'https://user:pass@cdn.example/a.mp4'},
 {'kind':'local','fingerprint':'bad','size':3},
 {'kind':'unknown','url':'https://cdn.example/a.mp4'}])
def test_source_security(source):
    with pytest.raises(ValueError):main.canonical_source(source,'owner')

def test_source_formats():
    assert main.canonical_source({'kind':'vk','url':'https://vk.ru/video_ext.php?oid=-1&id=2&hash=abc'},'x')['hash']=='abc'
    assert main.canonical_source({'kind':'local','fingerprint':'a'*64,'size':123,'name':'test.mp4'},'x')['name']=='test.mp4'
    assert main.canonical_source({'kind':'screen','title':'Screen'},'owner')['owner']=='owner'

async def fake_json(url,params=None,headers=None):
    if '/app/search/' in url:
        return [{'id':123,'name':{'main':'Test release'},'poster':{},'year':2026}]
    return {'id':123,'name':{'main':'Test release'},'poster':{},'episodes':[{'ordinal':1,'name':'Pilot','hls_720':'https://cdn.example/a.m3u8','hls_1080':'https://cdn.example/b.m3u8'}]}

def test_anilibria_api_adapter(client,monkeypatch):
    monkeypatch.setattr(content,'get_json',fake_json)
    data=client.get('/api/anime/search?q=Test&provider=anilibria').json();assert data['items'][0]['title']=='Test release'
    detail=client.get('/api/anime/details?id=123&provider=anilibria').json();assert detail['translations'][0]['seasons'][0]['episodes'][0]['qualities']==[720,1080]
    stream=client.get('/api/anime/stream?id=123&provider=anilibria&episode=1&quality=1080').json();assert stream['url']=='https://cdn.example/b.m3u8'

def test_blocked_release_is_not_bypassed(client,monkeypatch):
    async def blocked(*a,**k):return {'id':123,'is_blocked_by_geo':True}
    monkeypatch.setattr(content,'get_json',blocked)
    assert client.get('/api/anime/stream?id=123&provider=anilibria').status_code==403

def test_owned_movie_catalog(client,monkeypatch,tmp_path):
    path=tmp_path/'media.json';path.write_text(json.dumps({'123':{'title':'Our film','translations':[{'id':'original','name':'Original','seasons':[{'number':2,'episodes':[{'number':3,'label':'Episode 3','url':'https://cdn.example/test.mp4'}]}]}]}}))
    monkeypatch.setenv('MEDIA_CATALOG',str(path))
    assert client.get('/api/movies/123/sources').json()['provider']=='media'
    assert client.get('/api/movies/stream?id=123&translation=original&season=2&episode=3').json()['url'].endswith('.mp4')
