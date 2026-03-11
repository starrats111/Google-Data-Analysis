import time
import uuid

import requests
import logging
import re
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

class SemRush:
    def __init__(self, username, password, url, country):
        self.username = username
        self.password = password
        self.session = requests.Session()
        self.session.verify = False
        self.token = None
        self.country = country
        self.url = url
        self.node = None
        self.uuid = str(uuid.uuid4())

    def set_node(self, node):
        self.node = node

    def login(self):
        resp = self.session.get(f'https://dash.3ue.co/api/account/login?username={self.username}&password={self.password}&ts={int(time.time()*1000)}')
        try:
            self.token = resp.json()['data']['token']
        except:
            logging.error('Login failed')

    def get_apikey(self):
        cookies = {'GMITM_config': '{"semrush":{"node": ' + self.node + ',"lang":"zh"}}'}
        resp = self.session.get(url="https://sem.3ue.co/home/?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",cookies=cookies)
        try:
            regex = r'\"api_key\": \"(.*?)\"'
            match = re.findall(regex, resp.text)
            match = match[0]
            self.apikey = match
        except:
            logging.error('get api key failed')

    def organic(self):
        cookies = {'GMITM_config': '{"semrush":{"node": '+self.node+',"lang":"zh"}}'}
        data = {"id":12,"jsonrpc":"2.0","method":"organic.PositionsOverview","params":{"request_id":self.uuid,"report":"domain.overview","args":{"database":self.country,"dateType":"daily","dateFormat":"date","searchItem":self.url,"searchType":"domain","positionsType":"all"},"userId":444444444,"apiKey":self.apikey}}
        headers = {
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
            "content-length": str(len(data)),
        }
        resp = self.session.post(url="https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",json=data, cookies=cookies, verify=False, headers=headers)
        try:
            resp_data = resp.json()
            phrase_list = []
            for r in resp_data['result']:
                phrase_list.append(r['phrase'])
            # print(phrase_list)
            return phrase_list
        except:
            logging.error('organic failed')

    def adwords(self):
        cookies = {'GMITM_config': '{"semrush":{"node":' + self.node + ',"lang":"zh"}}'}

        t = int(time.time())
        data = [{"id":3,"jsonrpc":"2.0","method":"user.Databases","params":{"userId":444444444,"apiKey":self.apikey}},{"id":2,"jsonrpc":"2.0","method":"adwords.SnapshotDates","params":{"database":self.country,"userId":444444444,"apiKey":self.apikey}},{"id":3,"jsonrpc":"2.0","method":"currency.Rates","params":{"date":t,"userId":444444444,"apiKey":self.apikey}}]
        headers = {
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
            "content-length": str(len(data)),
        }
        resp = self.session.post(url="https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU", json=data,cookies=cookies, verify=False, headers=headers)
        try:
            daily = resp.json()[1]['result']['daily'][0]
        except:
            logging.error('adwords get token failed')
            return

        t = int(time.time())

        data = {"id":4,"jsonrpc":"2.0","method":"token.Get","params":{"reportType":"adwords.copies","database": self.country,"date":t,"dateType":"daily","searchItem": self.url,"page":1,"pageSize":100,"userId":444444444,"apiKey": self.apikey}}
        headers = {
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
            "content-length": str(len(data)),
        }
        resp = self.session.post(url="https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU", json=data,cookies=cookies, verify=False, headers=headers)
        try:
            token = resp.json()['result']['token']
        except:
            logging.error('adwords get token failed')
            return

        data = [{"id":5,"jsonrpc":"2.0","method":"adwords.Copies","params":{"token":token,"database": self.country,"searchItem":self.url,"searchType":"domain","date":daily,"dateType":"daily","filter":{},"display":{"order":{"field":"copy_positions","direction":"desc"},"page":1,"pageSize":100},"userId":444444444}},{"id":6,"jsonrpc":"2.0","method":"adwords.CopiesTotal","params":{"token": token,"database":"us","searchItem": self.url,"searchType":"domain","date":daily,"dateType":"daily","filter":{},"display":{"order":{"field":"copy_positions","direction":"desc"},"page":1,"pageSize":100},"userId":444444444}}]
        headers = {
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
            "content-length": str(len(data)),
        }
        resp = self.session.post(url="https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU", json=data,cookies=cookies, verify=False, headers=headers)
        try:
            resp_data = resp.json()
            title_list = []
            description_list = []
            for r in resp_data[0]['result']:
                title_list.append(r['title'])
                description_list.append(r['description'])
            # print(title_list, description_list)
            return title_list, description_list
        except:
            logging.error('adwords failed')

if __name__ == '__main__':
    sem = SemRush("yongpei", "kydir405", "nike.com", "us")
    sem.login()
    sem.set_node("10")
    sem.get_apikey()
    #sem.organic()
    print(sem.adwords())
